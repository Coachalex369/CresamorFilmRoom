const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireOwner } = require("../middleware/authorize");
const { canViewVideo, canViewVideosBatch } = require("../services/permissions");
const { lockAndAssertNotPurgePending, markForPurgeReevaluationSql } = require("../services/sourceRetention");
const { withPlaybackStatus } = require("../services/videoPlayback");
const { logSecurityEvent } = require("../services/auditLog");

const router = express.Router();

// Video-authorization bypass fix (found during the Personal Film audit):
// this route used to accept ANY video_id from ANY authenticated caller
// with zero check that they could actually view that video — the write
// side of a real gap, confirmed by direct-request testing, not merely a
// theoretical one. The web client's own playback UI happened not to leak
// actual video bytes as a side effect of unrelated behavior (jumpToClip()
// in app.js only plays a clip whose video_id is present in the caller's
// own already-authorized /api/videos list), but that's an accident of one
// client's rendering logic, not an authorization boundary — a direct API
// request could freely create (and, via the already-owner-scoped GET
// below, read back) a clip permanently referencing a video_id the caller
// has no relationship to at all, including another uploader's Personal
// Film or an unrelated team's private film. Same protected resource
// (video visibility) as canViewVideo already governs everywhere else;
// gated the same way, at creation time only — matching this project's
// existing "revoke stops future access, doesn't retroactively erase past
// artifacts" convention (e.g. messages), not a new pattern.
//
// Team Highlights, Slice 1: the video row is now locked (SELECT ... FOR
// UPDATE) inside this same transaction BEFORE the clip is inserted, and
// purge_status is checked under that lock — a plain unlocked read would
// be insufficient, since it could observe 'active' an instant before a
// concurrent physical purge flips it. Locking the identical row the
// purge transaction also locks (sourceRetention.js's
// lockCountAndMaybeFlipToPurgePending) is what makes reference-creation
// and the purge decision mutually exclusive, enforced by Postgres itself
// rather than application timing.
router.post("/api/clips", authenticate, async (req, res) => {
  const { title, start_time, end_time, video_id, client_request_id: clientRequestId } = req.body;

  if (!title || start_time === undefined || end_time === undefined || !video_id) {
    return res.status(400).json({ error: "Missing required clip fields" });
  }

  // Number.isFinite (not a bare <=) also rejects NaN/Infinity/non-numeric
  // input, not just "end before start" -- a bare `<=` is always false for
  // NaN, which would otherwise let a malformed direct API request (or a
  // client bug, e.g. an unset video duration) through as if it were valid.
  if (
    !Number.isFinite(Number(start_time)) ||
    !Number.isFinite(Number(end_time)) ||
    Number(end_time) <= Number(start_time)
  ) {
    return res.status(400).json({ error: "Clip end time must be after start time" });
  }

  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    let video;
    try {
      video = await lockAndAssertNotPurgePending(conn, video_id);
    } catch (lockError) {
      await conn.query("ROLLBACK");
      if (lockError.code === "VIDEO_NOT_FOUND") {
        return res.status(404).json({ error: "Video not found" });
      }
      if (lockError.code === "VIDEO_PURGE_PENDING") {
        return res.status(409).json({ error: "This video is no longer available" });
      }
      throw lockError;
    }

    if (!(await canViewVideo(req.user.id, video))) {
      await conn.query("ROLLBACK");
      return res.status(403).json({ error: "Not authorized to create a clip from this video" });
    }

    // One-Button Highlight release: an optional client_request_id makes
    // this endpoint idempotent per user. ON CONFLICT DO NOTHING against
    // the partial unique index (migration 020) means a retried/duplicated
    // submission of the SAME attempt never inserts a second row; when
    // that happens (0 rows back from the INSERT) the original row is
    // fetched and returned instead, so the caller always gets back "the"
    // clip for that attempt, not an error. A request with no
    // client_request_id (older/other callers) always inserts, unchanged
    // from prior behavior — the partial index only applies to non-null
    // values.
    const insertResult = await conn.query(
      `
      INSERT INTO clips (title, start_time, end_time, video_id, user_id, client_request_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
      RETURNING *
      `,
      [title, start_time, end_time, video_id, req.user.id, clientRequestId || null]
    );

    let clip = insertResult.rows[0];

    if (!clip && clientRequestId) {
      const existing = await conn.query(
        "SELECT * FROM clips WHERE user_id = $1 AND client_request_id = $2",
        [req.user.id, clientRequestId]
      );
      clip = existing.rows[0];
    }

    await conn.query("COMMIT");
    res.status(201).json(clip);
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.error("POST /api/clips error:", err);
    res.status(500).json({ error: "Failed to save clip" });
  } finally {
    conn.release();
  }
});

// One-Button Highlight release: owner-only delete. A clip is the "live
// reference" side of source retention (see sourceRetention.js) -- deleting
// it can be the event that makes a video eligible for physical purge, but
// ONLY if that video is already out of Film (film_removed_at set). Same
// gate teamHighlights.js's DELETE route uses for the identical reason: an
// active Film source must never become purge-eligible just because it
// currently has no clips/posts referencing it. markForPurgeReevaluationSql
// runs in the SAME transaction as the clip delete (cheap flag-set, no
// lock, no R2 call) -- the actual eligibility decision happens later,
// under its own proper lock, in the sweeper.
router.delete("/api/clips/:id", authenticate, async (req, res) => {
  const { id } = req.params;

  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    const result = await conn.query(
      `
      SELECT clips.id, clips.user_id, clips.video_id, videos.film_removed_at
      FROM clips
      LEFT JOIN videos ON videos.id = clips.video_id
      WHERE clips.id = $1
      FOR UPDATE OF clips
      `,
      [id]
    );

    const clip = result.rows[0];
    if (!clip) {
      await conn.query("ROLLBACK");
      return res.status(404).json({ error: "Highlight not found" });
    }

    if (Number(clip.user_id) !== Number(req.user.id)) {
      await conn.query("ROLLBACK");
      return res.status(403).json({ error: "Not authorized to delete this highlight" });
    }

    await conn.query("DELETE FROM clips WHERE id = $1", [id]);

    if (clip.video_id !== null && clip.film_removed_at !== null) {
      await conn.query(markForPurgeReevaluationSql(), [clip.video_id]);
    }

    await logSecurityEvent("clip_deleted", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { clipId: Number(id), videoId: clip.video_id },
      conn,
    });

    await conn.query("COMMIT");
    res.json({ id: clip.id, deleted: true });
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.error("DELETE /api/clips/:id error:", err);
    res.status(500).json({ error: "Failed to delete highlight" });
  } finally {
    conn.release();
  }
});

// One-Button Highlight release: owner-only rename. Title only -- start/end
// time and video_id are immutable once saved (renaming is the one
// after-the-fact edit the approved workflow actually calls for).
router.patch("/api/clips/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "Title is required" });
  }

  try {
    const result = await client.query(
      "UPDATE clips SET title = $1 WHERE id = $2 AND user_id = $3 RETURNING *",
      [String(title).trim(), id, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Highlight not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /api/clips/:id error:", err);
    res.status(500).json({ error: "Failed to rename highlight" });
  }
});

// Beta permissions audit fix: no ownership check beyond authenticate —
// any logged-in user could enumerate another user's clip titles/video
// ids by changing :id. Every current caller (home.js, app.js's
// loadMyClips()) already only ever requests currentUser.id; confirmed by
// inspection — nothing legitimate breaks.
//
// Team Highlights, Slice 1: each clip now embeds its own resolved,
// authorized playback info (clip.video, the exact same shape
// GET /api/videos/:id already returns via withPlaybackStatus) instead of
// the client separately fetching GET /api/videos and joining by video_id
// in memory. That join broke the moment Slice 1 made the Film list
// exclude film-removed sources: a clip whose source was removed from
// Film would silently vanish from Home/Profile reels even though the
// clip itself, and the source's R2 object, were both still completely
// intact — the Film list was never meant to double as a general "every
// video I can see" catalog, and using it that way is exactly what broke
// here. Re-checks authorization live per clip (not merely "was authorized
// at creation time") — matches this project's existing "revoke stops
// future access" discipline; a clip whose source access was later
// revoked gets video: null rather than ever leaking a signed URL the
// caller isn't currently authorized for. row_to_json avoids an N+1 query
// for the video JOIN (one JOIN, not one extra SELECT per clip) and
// sidesteps the column-name collisions a plain "clips.*, videos.*" would
// create (both tables have their own id/created_at).
//
// Correction: canViewVideosBatch() (not a per-clip canViewVideo() call)
// resolves authorization for every clip's video in one pass -- the JOIN
// above already eliminated the video-fetch N+1, but canViewVideo() itself
// still issues its own query (is_platform_admin, or canAccessTeam's
// team_members lookup) whenever a clip's video wasn't uploaded by the
// caller, which is the common case for a team-film highlight. A user with
// many highlights was issuing one extra authorization query per clip;
// this route now issues at most two, total, regardless of clip count.
router.get("/api/users/:id/clips", authenticate, requireOwner("id"), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT
        clips.id, clips.title, clips.start_time, clips.end_time,
        clips.video_id, clips.storage_key, clips.user_id, clips.created_at,
        row_to_json(videos.*) AS video_row
      FROM clips
      LEFT JOIN videos ON videos.id = clips.video_id
      WHERE clips.user_id = $1
      ORDER BY clips.id DESC
      `,
      [id]
    );

    const videosToAuthorize = result.rows.filter((row) => row.video_row).map((row) => row.video_row);
    const authorizedByVideoId = await canViewVideosBatch(req.user.id, videosToAuthorize);

    const enriched = await Promise.all(
      result.rows.map(async ({ video_row: videoRow, ...clip }) => {
        // Future materialized-clip case (storage_key set, video_id NULL)
        // — not built yet, no video row to resolve. clips_has_backing_
        // source guarantees this never leaves a clip with neither.
        if (!videoRow) return { ...clip, video: null };

        if (!authorizedByVideoId.get(videoRow.id)) return { ...clip, video: null };

        return { ...clip, video: await withPlaybackStatus(videoRow) };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error("GET /api/users/:id/clips error:", err);
    res.status(500).json({ error: "Failed to fetch user clips" });
  }
});

module.exports = router;
