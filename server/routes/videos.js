const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const client = require("../db/client");
const {
  classifyAndRouteAsync,
  retryClassification,
  retryConversion,
} = require("../services/videoProcessing");
const {
  canDeleteVideo,
  canViewVideo,
  canManageTeam,
  canAccessTeam,
} = require("../services/permissions");
const storage = require("../services/storage/storage");
const { authenticate } = require("../middleware/authenticate");
const { uploadLimiter } = require("../middleware/rateLimiters");
const { logSecurityEvent } = require("../services/auditLog");
const uploadAttempts = require("../services/uploadAttempts");
const sourceRetention = require("../services/sourceRetention");
const { withPlaybackStatus } = require("../services/videoPlayback");

const router = express.Router();

// Beta Readiness Sprint 2: environment-driven, not hardcoded, so a full
// game recording exceeding the default doesn't require a code change to
// accommodate. Streaming multipart upload to R2 (see storage/r2Storage.js)
// never buffers the file in memory, so this ceiling is about reasonable
// abuse prevention and temp-disk space, not RAM.
const MAX_VIDEO_UPLOAD_MB = Number(process.env.MAX_VIDEO_UPLOAD_MB) || 3072;

// Beta Readiness Sprint 1 (R2 migration): multer now writes to a scratch
// temp dir, not the final destination. storage.upload() (local disk or
// R2, whichever STORAGE_PROVIDER is active) takes it from there — see
// ARCHITECTURE.md's "Storage strategy" for why (avoids buffering full
// video uploads in memory on Render's constrained instance).
const tempUploadsDir = path.join(__dirname, "../../uploads/.tmp");
if (!fs.existsSync(tempUploadsDir)) {
  fs.mkdirSync(tempUploadsDir, { recursive: true });
}

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempUploadsDir);
  },
  filename: (req, file, cb) => {
    // This is only the TEMP filename (uploads/.tmp/) — never the storage
    // key videos actually get stored/served under. Doesn't need to be
    // opaque; it's deleted the moment storage.upload() finishes.
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage: tempStorage,
  // First layer of MIME validation — fails fast, before multer even
  // finishes writing the temp file. storage.upload() enforces the same
  // allowlist again as the second layer (see storage.js) — this file
  // reuses that single source of truth via storage.isAllowed() rather
  // than keeping its own separate list.
  fileFilter: (req, file, cb) => {
    if (!storage.isAllowed("video", file.mimetype)) {
      return cb(new Error(`Unsupported video type: ${file.mimetype}`));
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_VIDEO_UPLOAD_MB * 1024 * 1024 },
});

router.get("/api/videos", authenticate, async (req, res) => {
  try {
    // Team Highlights, Slice 1: the Film library list excludes anything
    // logically removed from Film (film_removed_at) and anything
    // destined for Team Highlights instead — that content has its own
    // dedicated feed (Slice 2) and was never meant to clutter Team Film
    // Breakdown. GET /api/videos/:id below is deliberately NOT filtered
    // this way — direct playback (from a Team Highlights post or a clip)
    // must keep working regardless of Film-list visibility.
    //
    // Rollout-safety correction: "upload_destination != 'team_highlights'"
    // alone silently EXCLUDES a row where upload_destination IS NULL — a
    // plain "x != y" comparison evaluates to NULL, not TRUE, when x is
    // NULL, and Postgres's WHERE clause treats NULL as "don't include
    // this row." During the expand/deploy/contract rollout window (018
    // applied, new code not deployed yet — see 018's own header),
    // currently-deployed code's INSERT never sets this column at all, so
    // every video it creates would silently vanish from the Film list,
    // including for its own uploader, the instant this migration landed
    // — found by actually running the full local regression suite against
    // a legacy-shaped row, not by inspection. NULL can never legitimately
    // mean 'team_highlights' here (that destination is always explicit,
    // hard-rejected server-side in Slice 1's own upload route), so it's
    // always correct to treat it the same as any other non-team_highlights
    // row.
    const result = await client.query(
      `
      SELECT *
      FROM videos
      WHERE film_removed_at IS NULL
        AND (upload_destination IS NULL OR upload_destination != 'team_highlights')
      ORDER BY id DESC
      `
    );

    // Team-scoped visibility (Beta Readiness Sprint 2): a per-row filter,
    // not a route-level gate — canViewVideo covers both the team_id IS
    // NULL case (uploader-or-coach) and the team-membership case.
    const visible = [];
    for (const video of result.rows) {
      if (await canViewVideo(req.user.id, video)) visible.push(video);
    }

    res.json(await Promise.all(visible.map(withPlaybackStatus)));
  } catch (err) {
    console.error("GET /api/videos error:", err);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

// Foundation Sprint Phase 3: added so clients can poll a single video's
// processing_status after upload instead of re-fetching the whole list.
//
// Diagnostic addition (post-OOM-incident): also reports live_size_bytes —
// a real storage.getObjectSize() call against the CURRENT storage_key,
// not a persisted column. Deliberately only on this single-video route,
// not the list endpoint, since it's one extra HEAD request per call and
// this route is already the low-frequency, targeted one (unlike the list
// endpoint, which real clients poll repeatedly). Exists so a video's
// actual size can be confirmed from the browser (no CORS/CSP issues,
// since it's the app's own API) without needing direct R2 credentials or
// shell access to the production instance. Best-effort: null on any
// failure, never lets a size-check problem break the rest of the response.
router.get("/api/videos/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query("SELECT * FROM videos WHERE id = $1", [id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!(await canViewVideo(req.user.id, result.rows[0]))) {
      return res.status(403).json({ error: "Not authorized to view this video" });
    }

    const video = result.rows[0];
    const withStatus = await withPlaybackStatus(video);

    let live_size_bytes = null;
    if (video.storage_key) {
      try {
        live_size_bytes = await storage.getObjectSize(video.storage_key);
      } catch (sizeError) {
        console.error(`GET /api/videos/:id live size check failed for ${id}:`, sizeError.message);
      }
    }

    res.json({ ...withStatus, live_size_bytes });
  } catch (err) {
    console.error("GET /api/videos/:id error:", err);
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

router.post("/api/videos", authenticate, async (req, res) => {
  try {
    const { title, file_url } = req.body;

    if (!title || !file_url) {
      return res.status(400).json({ error: "Missing required video fields" });
    }

    const result = await client.query(
      `
      INSERT INTO videos (title, file_url, uploaded_by)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [title, file_url, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/videos error:", err);
    res.status(500).json({ error: "Failed to create video" });
  }
});

// TEMPORARY diagnostic wrapper (native-recording HTTP 500 investigation):
// multer/busboy is itself a middleware — a multipart parsing failure
// (e.g. "Unexpected end of form") calls next(err) and skips the route
// handler function below ENTIRELY, so logging placed only inside that
// function can never see this failure mode. This brackets multer's own
// processing so we know it was reached, and what specifically failed,
// even when the route handler never runs at all. Never logs file bytes,
// tokens, or request bodies — only the error's own name/code/message.
// Remove once the native-recording 500 is root-caused.
function uploadDiagnosticMulter(req, res, next) {
  console.log("[UPLOAD DIAGNOSTIC] multer started");
  upload.single("video")(req, res, (err) => {
    if (err) {
      console.error(
        `[UPLOAD DIAGNOSTIC] multer failed: name=${err.name} code=${err.code || "(none)"} message=${err.message}`
      );
    } else {
      console.log("[UPLOAD DIAGNOSTIC] multer completed successfully");
    }
    next(err);
  });
}

router.post("/api/upload-video", authenticate, uploadLimiter, uploadDiagnosticMulter, async (req, res) => {
  let attempt = null;
  let leaseToken = null;

  // Multer has already written req.file.path to temp disk by the time
  // this handler runs, BEFORE any of this route's own validation. Every
  // early-return path below (invalid destination, unauthorized team_id,
  // idempotent replay, already-in-progress, the premature
  // 'team_highlights' rejection, and every other rejection) would
  // otherwise leak that temp file forever — storage.upload() only ever
  // cleans it up on the one path that actually reaches it. This finally
  // block guarantees cleanup on every exit, success or failure alike;
  // tolerant of "already gone" since storage.upload() itself already
  // removes the file (R2: unlink after streaming; local: rename, which
  // also removes the source) on the success path.
  try {
    // req.body can be undefined (not just missing fields) for a request
    // with no multipart body at all -- a real bug on main too (same
    // unguarded destructuring at this route), found here by actually
    // exercising this path for the first time rather than by inspection.
    // Defaulting to {} lets the real validation below (title, req.file)
    // produce its intended clean 400 instead of an unhandled 500.
    const { title, team_id, film_type } = req.body || {};
    const teamId = team_id || null;

    if (!req.file) {
      return res.status(400).json({ error: "No video file uploaded" });
    }

    if (!title) {
      return res.status(400).json({ error: "Missing required upload fields" });
    }

    // Team Highlights, Slice 1: destination is now explicit, not merely
    // inferred from team_id's presence. A caller MAY send
    // upload_destination directly (forward-compatible with Slice 3's
    // real destination picker); a legacy caller that omits it gets the
    // exact same derivation this route has always used — team_id present
    // -> 'team_film', absent -> 'personal'. 'team_highlights' is only
    // ever reachable via an explicit, validated request — no caller can
    // land there by accident.
    const requestedDestination = req.body.upload_destination;
    const uploadDestination = requestedDestination || (teamId ? "team_film" : "personal");

    if (!["personal", "team_film", "team_highlights"].includes(uploadDestination)) {
      return res.status(400).json({ error: "Invalid upload_destination" });
    }
    if (uploadDestination === "personal" && teamId) {
      return res.status(400).json({ error: "Personal Film cannot specify a team" });
    }
    if (uploadDestination !== "personal" && !teamId) {
      return res.status(400).json({ error: "team_id is required for this destination" });
    }

    // Team Highlights, Slice 1: 'team_highlights' has no usable workflow
    // yet — no feed, no publish route, and nothing yet creates the
    // matching team_highlights post atomically with the video (that's
    // Slice 2/3's job). Accepting this value now would silently create a
    // video excluded from the Film list (upload_destination !=
    // 'team_highlights' filter) with no corresponding post anywhere —
    // effectively invisible, orphaned content. Rejected outright until
    // the complete destination workflow ships.
    if (uploadDestination === "team_highlights") {
      return res.status(400).json({ error: "Team Highlights uploads are not available yet" });
    }

    // Unassigned-video authorization fix (team_id validation), still the
    // universal floor for any team-targeted upload — an active,
    // non-revoked team_members row on that exact team, ANY role_on_team.
    // Deliberately not coach-specific here: the Record flow's
    // athlete/parent uploads to their own team must keep working exactly
    // as before. A per-destination-type authority check (the
    // Coach/Assistant-Coach-only bar for 'team_film') is real future work
    // for Slice 3's client/route changes, not built here.
    if (teamId && !(await canAccessTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "You do not have an active membership on that team" });
    }

    // Personal Film upload authorization: no server-side capability check
    // here yet. A prior Slice 1 draft added canUploadPersonalFilm() (a
    // global users.role='coach'-or-live-coaching-membership check), but
    // that account model is already superseded (capabilities should
    // derive from live team membership/selected team context, not a
    // permanent global role) and the helper was never enforced anywhere
    // -- removed rather than shipped inert. The current production
    // Record flow's "Skip for now" path still lets a Parent/Athlete land
    // in Personal Film; the real capability rule is deferred to be
    // redesigned alongside the unified-login/Team Highlights work.

    // Team Highlights, Slice 1: durable idempotency-key claim, BEFORE any
    // R2 call. idempotency_key is optional for backward compatibility —
    // a legacy caller (today's uploadVideo()/capture.js, unmodified until
    // Slice 3) gets a fresh server-generated key per request, which is
    // exactly today's no-idempotency behavior, not a regression. See
    // uploadAttempts.js's own header comment for the full state machine.
    const idempotencyKey = req.body.idempotency_key || crypto.randomUUID();

    const claim = await uploadAttempts.claimOrGetAttempt({
      userId: req.user.id,
      idempotencyKey,
      teamId,
      uploadDestination,
    });

    if (claim.alreadyCompleted) {
      console.log(`[UPLOAD DIAGNOSTIC] idempotent replay: attempt ${claim.attempt.id} already completed`);
      const existingVideo = await client.query("SELECT * FROM videos WHERE id = $1", [claim.attempt.video_id]);
      return res.status(201).json(existingVideo.rows[0]);
    }

    // A replay of a key whose prior upload succeeded but whose resulting
    // video was later physically purged (sourceRetention.js). Explicit,
    // final answer -- never silently mints a new upload under this same
    // key (see uploadAttempts.js's claimOrGetAttempt for why that would be
    // surprising), and never touches R2/storage or creates any row.
    if (claim.sourcePurged) {
      return res.status(410).json({
        error: "The video this upload previously produced was already removed and is no longer available.",
      });
    }

    if (claim.inProgress) {
      return res.status(409).json({ error: "An upload with this request is already in progress" });
    }

    attempt = claim.attempt;
    leaseToken = attempt.lease_token;

    // TEMPORARY diagnostic (native-recording 500 investigation): only
    // req.file's own safe metadata fields — never file bytes, never
    // req.body values, never tokens.
    console.log(
      `[UPLOAD DIAGNOSTIC] req.file: fieldname=${req.file.fieldname} originalname=${req.file.originalname} mimetype=${req.file.mimetype} size=${req.file.size}`
    );

    // Beta Readiness Sprint 1: new uploads always go through the storage
    // abstraction (storage_key set, file_url left NULL) — local disk or
    // R2, whichever STORAGE_PROVIDER is active. Legacy rows (storage_key
    // NULL) are untouched and keep using file_url forever; this is not a
    // migration of old rows, only where new ones land.
    //
    // Opaque key refinement: no original filename in the key — just an
    // organizational prefix (team/year) and a random UUID.
    const extension = storage.extensionFor("video", req.file.mimetype);
    const year = new Date().getFullYear();
    const teamSegment = teamId || "unassigned";
    const storageKey = `videos/${teamSegment}/${year}/${crypto.randomUUID()}${extension}`;

    // Persisted BEFORE the R2 call — from this point on, every possible
    // R2 object this attempt could produce has a durable, discoverable
    // key even if the process crashes mid-upload.
    attempt = await uploadAttempts.persistUploadingState(attempt.id, leaseToken, storageKey);

    // Real progress-driven lease renewal, not just the fixed initial
    // lease window — wired through storage.js's provider-neutral
    // onProgress hook to r2Storage's actual httpUploadProgress event.
    // Throttled (at most once per HEARTBEAT_MIN_INTERVAL_MS) since a
    // large multipart transfer can emit many progress events per second.
    // Fire-and-forget by necessity (the SDK's progress event is
    // synchronous; renewLease() is a DB call) — correctness does NOT
    // depend on this actually running or succeeding: persistUploadingState/
    // markR2Uploaded/completeAttempt all independently re-check the lease
    // token via their own WHERE clauses regardless, so a missed or failed
    // heartbeat can only ever cause an earlier, correctly-fenced failure
    // downstream, never a stale advancement. leaseFenced is set purely as
    // a fast-fail signal to avoid finishing an upload already known to be
    // reclaimed; actually aborting the in-flight R2 transfer on fence loss
    // is not implemented in this slice (would need storage.upload() to
    // expose a real abort handle, a further interface change) — flagged,
    // not silently assumed solved.
    const HEARTBEAT_MIN_INTERVAL_MS = 15 * 1000;
    let lastHeartbeatAttemptAt = 0;
    let leaseFenced = false;

    console.log("[UPLOAD DIAGNOSTIC] storage/R2 upload started");
    await storage.upload(storageKey, req.file.path, req.file.mimetype, {
      category: "video",
      onProgress: () => {
        const now = Date.now();
        if (now - lastHeartbeatAttemptAt < HEARTBEAT_MIN_INTERVAL_MS) return;
        lastHeartbeatAttemptAt = now;

        uploadAttempts
          .renewLease(attempt.id, leaseToken)
          .then((renewed) => {
            if (!renewed) {
              leaseFenced = true;
              console.error(`[UPLOAD DIAGNOSTIC] lease renewal failed mid-upload for attempt ${attempt.id} — already reclaimed`);
            }
          })
          .catch((error) => {
            console.error(`[UPLOAD DIAGNOSTIC] lease renewal errored mid-upload for attempt ${attempt.id}:`, error.message);
          });
      },
    });
    console.log("[UPLOAD DIAGNOSTIC] storage/R2 upload completed");

    if (leaseFenced) {
      const fencedError = new Error("Lost ownership of this upload attempt (lease expired or reclaimed)");
      fencedError.code = "LEASE_LOST";
      throw fencedError;
    }

    attempt = await uploadAttempts.markR2Uploaded(attempt.id, leaseToken);

    // Foundation Sprint Phase 1: team_id/film_type are now real columns —
    // capture.js sends them directly instead of Sprint 1's workaround of
    // folding them into the title string. Both stay optional since the
    // manual coach upload path still doesn't collect either.
    console.log("[UPLOAD DIAGNOSTIC] DB insert started");
    let video;
    let teamHighlight;
    try {
      ({ video, teamHighlight } = await uploadAttempts.completeAttempt(attempt.id, leaseToken, {
        title,
        storageKey,
        userId: req.user.id,
        teamId,
        uploadDestination,
        filmType: film_type || null,
        fileSize: req.file.size,
      }));
    } catch (completeError) {
      if (completeError.code !== "LEASE_LOST") {
        // The R2 object already exists at this point but nothing in the
        // DB references it — immediate, best-effort cleanup attempt now,
        // durable cleanup_pending record if that also fails.
        await uploadAttempts.handleCompletionFailureCleanup(attempt.id, leaseToken, storageKey);
      }
      throw completeError;
    }
    console.log(`[UPLOAD DIAGNOSTIC] DB insert completed: video id=${video.id}`);

    // Foundation Sprint Phase 3: this route now only receives the upload —
    // it responds immediately instead of blocking on processing. The
    // client polls/reloads to observe uploading -> classifying ->
    // (remuxing ->) ready. Deliberately NOT awaited: classification/remux
    // can take real time, and this request/response contract already
    // doesn't assume it's fast.
    //
    // Play-First Pipeline: every upload goes through classification now —
    // size plays no part in this decision. See classifyAndRoute() in
    // videoProcessing.js for the playable/remux/transcode_needed routing.
    console.log("[UPLOAD DIAGNOSTIC] processing/classification enqueue started");
    classifyAndRouteAsync(video);

    console.log("[UPLOAD DIAGNOSTIC] response 201 sent");
    res.status(201).json(video);
  } catch (err) {
    if (err.code === "LEASE_LOST") {
      // Ownership of this attempt was reclaimed (the sweeper decided it
      // was abandoned) while this request was still working — never mark
      // it failed ourselves, that would race whatever the reclaiming
      // process is doing. Report a clear, retriable error instead.
      console.error(`[UPLOAD DIAGNOSTIC] lease lost mid-upload for attempt ${attempt ? attempt.id : "?"}`);
      return res.status(409).json({ error: "This upload took too long and was reclaimed — please retry" });
    }

    if (attempt && leaseToken) {
      await uploadAttempts.markFailed(attempt.id, leaseToken, err.message).catch(() => {});
    }
    console.error(
      `[UPLOAD DIAGNOSTIC] route handler caught: name=${err.name} code=${err.code || "(none)"} message=${err.message}`
    );
    console.error("POST /api/upload-video error:", err);
    res.status(500).json({ error: "Failed to upload video" });
  } finally {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr && unlinkErr.code !== "ENOENT") {
          console.error("[UPLOAD DIAGNOSTIC] failed to clean up temp file:", req.file.path, unlinkErr);
        }
      });
    }
  }
});

// Team Highlights, Slice 1: "Remove from Film" — logically hides a source
// from the Film library without touching its row or R2 object. This is
// the ONLY removal action the normal Film UI exposes; there is no
// "Delete Permanently" control anywhere in the client for this feature.
// Same authorization as physical deletion below (nothing is being
// destroyed, so there's no reference-count guard to apply here) — marks
// the source for purge reevaluation IN THE SAME TRANSACTION as the
// removal itself, so the cleanup request can never be silently lost even
// if a separate follow-up write would have failed. The sweeper (not this
// request) decides later whether anything still depends on this source;
// an active Film source that was never removed is never touched by that
// process no matter how many or how few clips/highlights it has.
router.patch("/api/videos/:id/film-removal", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!(await canDeleteVideo(req.user.id, id))) {
      return res.status(403).json({ error: "Not authorized to remove this video from Film" });
    }

    if (video.film_removed_at) {
      return res.json(await withPlaybackStatus(video)); // idempotent no-op
    }

    const updated = await client.query(
      `
      UPDATE videos
      SET film_removed_at = now(), film_removed_by = $1, purge_reevaluation_requested_at = now()
      WHERE id = $2
      RETURNING *
      `,
      [req.user.id, id]
    );

    await logSecurityEvent("video_film_removed", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { videoId: Number(id), uploadedBy: video.uploaded_by },
    });

    res.json(await withPlaybackStatus(updated.rows[0]));
  } catch (err) {
    console.error("PATCH /api/videos/:id/film-removal error:", err);
    res.status(500).json({ error: "Failed to remove video from Film" });
  }
});

// Physical deletion — genuine, permanent removal of the R2 object(s) and
// the videos row. Kept deliberately meaning exactly that (not redefined
// into a soft action) so a 409 here reads as the natural, expected "can't
// delete, here's why" response rather than a silently changed contract.
// No normal-user UI control in this feature calls this route at all —
// real cleanup happens automatically via the reevaluation/sweeper path
// (see sourceRetention.js), triggered by film-removal above or (Slice 2)
// a Team Highlight post's removal. This route remains reachable directly
// (uploader or Platform Admin, same authorization as before) for
// administrative/scripted use, exercised by this slice's own tests.
router.delete("/api/videos/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const allowed = await canDeleteVideo(req.user.id, id);

    if (!allowed) {
      return res.status(403).json({ error: "Not authorized to delete this video" });
    }

    const result = await sourceRetention.attemptPurge(id, req.user.id);

    if (result.outcome === "not_found") {
      return res.status(404).json({ error: "Video not found" });
    }

    if (result.outcome === "already_pending") {
      return res.status(409).json({ error: "This video is already being deleted" });
    }

    if (result.outcome === "blocked") {
      return res.status(409).json({
        error: `Cannot delete this video: ${result.activePosts} Team Highlight post(s) and ${result.unmaterializedClips} clip(s) still depend on it`,
        activePosts: result.activePosts,
        unmaterializedClips: result.unmaterializedClips,
      });
    }

    if (result.outcome === "r2_delete_failed") {
      // The video is durably marked purge_pending and will be retried by
      // the sweeper — not a request failure from the caller's point of
      // view, but not yet actually gone either.
      return res.status(202).json({ success: true, id: Number(id), pending: true });
    }

    res.json({ success: true, id: Number(id) });
  } catch (err) {
    console.error("DELETE /api/videos/:id error:", err);
    res.status(500).json({ error: "Failed to delete video" });
  }
});

// Team-scoped video reassignment. The destination side is governed by
// canManageTeam(), the same per-team-coach concept that already gates
// invitations — reassignment is a team-scoped authorization operation,
// not a general video-management one, so a coach's blanket
// uploader-or-admin authority (canDeleteVideo) isn't the right bar there.
//   Team A -> Team B: must manage BOTH A and B (leaving A's visibility
//     boundary AND entering B's).
//   Team A -> Unassigned: must manage A only (nothing to check on the
//     "Unassigned" side — it isn't a team).
//   No-op (same team, or Unassigned -> Unassigned): short-circuits before
//     any authorization check at all.
// Unassigned-video authorization fix: the SOURCE side, when leaving
// Personal Film (currentTeamId === null), used to have NO check at all —
// worse than the old "any global coach" video rule, since it let literally
// any coach who merely managed the DESTINATION team pull someone else's
// unassigned video out of Personal Film, with zero relationship to the
// video or its uploader required. Now reuses canDeleteVideo() (uploader
// or Platform Admin for an unassigned video, matching the same fix
// applied to canViewVideo/canDeleteVideo) for that side specifically —
// the destination side's canManageTeam() check below is unchanged and
// still evaluated separately.
// "Team doesn't exist" and "exists but you don't manage it" deliberately
// return the identical 403 — same "don't let a caller fingerprint why"
// principle authenticate.js already uses for login rejections.
router.patch("/api/videos/:id/team", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const destinationTeamId = req.body.team_id === undefined ? null : req.body.team_id;

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const currentTeamId = video.team_id;

    if (currentTeamId === destinationTeamId) {
      return res.json(await withPlaybackStatus(video));
    }

    if (currentTeamId === null) {
      if (!(await canDeleteVideo(req.user.id, id))) {
        return res.status(403).json({ error: "Not authorized to move this video out of Personal Film" });
      }
    } else if (!(await canManageTeam(req.user.id, currentTeamId))) {
      return res.status(403).json({ error: "Not authorized to remove this video from its current team" });
    }

    if (destinationTeamId !== null && !(await canManageTeam(req.user.id, destinationTeamId))) {
      return res.status(403).json({ error: "Not authorized to assign videos to that team" });
    }

    const updated = await client.query(
      "UPDATE videos SET team_id = $1 WHERE id = $2 RETURNING *",
      [destinationTeamId, id]
    );

    await logSecurityEvent("video_team_reassigned", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { videoId: Number(id), fromTeamId: currentTeamId, toTeamId: destinationTeamId },
    });

    res.json(await withPlaybackStatus(updated.rows[0]));
  } catch (err) {
    console.error("PATCH /api/videos/:id/team error:", err);
    res.status(500).json({ error: "Failed to change video team" });
  }
});

// Beta Stabilization Sprint: the safe manual retry mechanism — what
// unsticks a video stuck in 'converting' (e.g. from a crash the boot-time
// recovery hasn't caught yet), a genuinely 'failed' conversion, or a
// 'deferred' one. Same uploader-or-coach authority as delete — reused,
// not reinvented.
//
// Production incident: this used to always attempt conversion regardless
// of size. A manual retry of the ~685MB wrestling video did exactly that
// and OOM'd the 512MB instance — the same failure mode the boot-time
// recovery redesign exists to prevent, just triggered manually instead of
// automatically. retryConversion() now applies the same size cap as every
// other path; an oversized video comes back "deferred" with no
// conversion ever started, not a 500 and not a launched FFmpeg process.
router.post("/api/videos/:id/retry-conversion", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!(await canDeleteVideo(req.user.id, id))) {
      return res.status(403).json({ error: "Not authorized to retry this video" });
    }

    if (!["converting", "failed", "deferred"].includes(video.processing_status)) {
      return res.status(400).json({ error: `Video is not in a retriable state (currently '${video.processing_status}')` });
    }

    const outcome = await retryConversion(video.id);

    res.json({
      success: outcome.outcome !== "size_unverifiable",
      id: Number(id),
      processing_status: outcome.processing_status,
      ...(outcome.message ? { message: outcome.message } : {}),
    });
  } catch (err) {
    console.error("POST /api/videos/:id/retry-conversion error:", err);
    res.status(500).json({ error: "Failed to retry conversion" });
  }
});

// Play-First Pipeline's manual retry — what a coach hits for a video
// that's 'failed' (a genuine classify/remux error), 'transcode_paused'
// (genuinely incompatible codecs — retrying costs nothing and covers "a
// transcode worker now exists" without a separate code path), a legacy
// 'deferred' row not yet reclassified, or one that looks stuck mid
// 'classifying'/'remuxing'. No size check anywhere in this path — that's
// the entire point of the migration away from retry-conversion above.
router.post("/api/videos/:id/retry-classification", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!(await canDeleteVideo(req.user.id, id))) {
      return res.status(403).json({ error: "Not authorized to retry this video" });
    }

    if (!["classifying", "remuxing", "failed", "transcode_paused", "deferred"].includes(video.processing_status)) {
      return res.status(400).json({ error: `Video is not in a retriable state (currently '${video.processing_status}')` });
    }

    const outcome = await retryClassification(video.id);

    res.json({
      success: outcome.outcome === "classifying",
      id: Number(id),
      processing_status: outcome.processing_status || video.processing_status,
    });
  } catch (err) {
    console.error("POST /api/videos/:id/retry-classification error:", err);
    res.status(500).json({ error: "Failed to retry classification" });
  }
});

module.exports = router;
