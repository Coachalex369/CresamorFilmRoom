/*
  videoUploads.js — resumable, direct-to-R2 multipart video uploads.
  Additive alongside videos.js's POST /api/upload-video, which is
  completely untouched and keeps serving short clips unmodified (see
  ARCHITECTURE.md / the resumable-uploads plan for the rollout strategy).

  Flow: initiate (server checks team-upload authorization, creates the R2
  multipart upload + a video_uploads tracking row) -> the browser PUTs
  file.slice() chunks straight to R2 using short-lived presigned URLs
  minted here, one at a time, on demand -> complete (server asks R2 to
  actually assemble the object, verifies the result, creates the videos
  row) -> or abort (explicit cancel, or the orphan sweep in
  uploadSweep.js for sessions nobody ever finished).

  Deliberately R2-only. STORAGE_PROVIDER=local has no meaningful equivalent
  to "browser PUTs directly to a short-lived signed URL" -- see r2Storage.js's
  comment above these functions for why this isn't built out for local disk
  too the way getObjectSize/downloadToFile were.

  Every route path uses video_uploads.session_id (a server-generated UUID)
  -- never r2_upload_id, R2/S3's own multipart UploadId. That value is
  opaque, may contain URL-significant characters, and the client has no
  legitimate reason to see or hold it; it's looked up server-side from
  session_id on every call instead.
*/

const express = require("express");
const crypto = require("crypto");

const client = require("../db/client");
const storage = require("../services/storage/storage");
const { authenticate } = require("../middleware/authenticate");
const { initiateUploadLimiter, presignPartLimiter } = require("../middleware/rateLimiters");
const { logSecurityEvent } = require("../services/auditLog");
const { classifyAndRouteAsync } = require("../services/videoProcessing");
const { canUploadToTeam } = require("../services/permissions");

const router = express.Router();

// Same ceiling as videos.js's MAX_VIDEO_UPLOAD_MB, read from the same env
// var -- kept as a separate constant (not exported/shared) rather than
// touching videos.js, per the plan's "no changes to videos.js" commitment.
const MAX_VIDEO_UPLOAD_MB = Number(process.env.MAX_VIDEO_UPLOAD_MB) || 3072;

// 10MB default: comfortably above R2/S3's ~5MB minimum part size (every
// part except the last must meet it), small enough that a single failed
// part is a cheap retry even on a poor connection. Configurable without a
// code change for the same reason MAX_VIDEO_UPLOAD_MB is.
const UPLOAD_PART_SIZE_MB = Number(process.env.UPLOAD_PART_SIZE_MB) || 10;
const PART_SIZE_BYTES = UPLOAD_PART_SIZE_MB * 1024 * 1024;

function requireR2(req, res, next) {
  if (process.env.STORAGE_PROVIDER !== "r2") {
    return res.status(501).json({ error: "Resumable uploads require STORAGE_PROVIDER=r2" });
  }
  next();
}

// session_id is a Postgres UUID column -- a malformed value (garbage in
// the URL, someone probing) would otherwise reach the DB as an "invalid
// input syntax for type uuid" error and surface as a raw 500 instead of a
// clean 404. Checked up front so an invalid id is indistinguishable from
// a well-formed one that just doesn't exist, same "don't let a caller
// fingerprint why" principle as the ownership check itself.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every non-initiate endpoint below looks a session up this same way --
// scoped to the authenticated caller, so one user can never see or act on
// another's session even if they somehow learned its session_id. A row
// that exists but belongs to someone else and a row that doesn't exist at
// all return the identical 404, matching this project's existing "don't
// let a caller fingerprint why" convention (see authenticate.js).
async function loadOwnedUpload(sessionId, userId) {
  if (!UUID_PATTERN.test(sessionId)) return null;

  const result = await client.query(
    "SELECT * FROM video_uploads WHERE session_id = $1 AND user_id = $2",
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

router.post("/api/video-uploads/initiate", authenticate, initiateUploadLimiter, requireR2, async (req, res) => {
  try {
    const { title, team_id, file_name, file_size, content_type, last_modified } = req.body;

    if (!title || !file_name || !content_type) {
      return res.status(400).json({ error: "Missing required upload fields" });
    }

    if (!storage.isAllowed("video", content_type)) {
      return res.status(400).json({ error: `Unsupported video type: ${content_type}` });
    }

    const fileSize = Number(file_size);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: "file_size must be a positive number" });
    }
    if (fileSize > MAX_VIDEO_UPLOAD_MB * 1024 * 1024) {
      return res.status(400).json({ error: "File is too large." });
    }

    // Beta scope: a valid team_id is REQUIRED here, unlike the legacy
    // POST /api/upload-video route (which still accepts no team_id at all,
    // preserved as-is for parity). Unassigned multipart uploads aren't
    // authorized yet -- a personal/unassigned large-upload destination is
    // real future work, not something this endpoint quietly allows by
    // omission. team_id: null/undefined is rejected outright, not treated
    // as "no team check needed" -- that was exactly the bypass a client
    // could otherwise use to dodge canUploadToTeam() entirely.
    if (!team_id) {
      return res.status(400).json({ error: "team_id is required" });
    }

    // No client-supplied team_id is trusted on its own: the caller must
    // have active coach/assistant-coach standing on THAT specific team.
    // Excludes a team-scoped 'parent' role and anyone with no membership at
    // all -- an unrelated user can't target another team by guessing its
    // id. Parent uploads are meant for a separate future "Team Highlights"
    // destination, not this endpoint. See canUploadToTeam() in
    // permissions.js for exactly who qualifies and why.
    if (!(await canUploadToTeam(req.user.id, team_id))) {
      return res.status(403).json({ error: "Not authorized to upload to that team" });
    }

    const extension = storage.extensionFor("video", content_type);
    const year = new Date().getFullYear();
    const storageKey = `videos/${team_id}/${year}/${crypto.randomUUID()}${extension}`;

    const r2UploadId = await storage.createMultipartUpload(storageKey, content_type);
    const sessionId = crypto.randomUUID();

    const partCount = Math.max(1, Math.ceil(fileSize / PART_SIZE_BYTES));

    const inserted = await client.query(
      `
      INSERT INTO video_uploads
        (session_id, r2_upload_id, storage_key, user_id, team_id, title, content_type,
         file_name, file_size, last_modified, part_size, part_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      `,
      [
        sessionId,
        r2UploadId,
        storageKey,
        req.user.id,
        team_id || null,
        title,
        content_type,
        file_name,
        fileSize,
        last_modified || null,
        PART_SIZE_BYTES,
        partCount,
      ]
    );

    const row = inserted.rows[0];
    res.status(201).json({
      uploadId: row.session_id, // client-facing identifier -- the safe session_id, never r2_upload_id
      storageKey: row.storage_key,
      partSize: row.part_size,
      partCount: row.part_count,
    });
  } catch (err) {
    console.error("POST /api/video-uploads/initiate error:", err);
    res.status(500).json({ error: "Failed to start upload" });
  }
});

router.post(
  "/api/video-uploads/:sessionId/parts/:partNumber/presign",
  authenticate,
  presignPartLimiter,
  requireR2,
  async (req, res) => {
    try {
      const { sessionId, partNumber } = req.params;
      const partNum = Number(partNumber);

      if (!UUID_PATTERN.test(sessionId)) {
        return res.status(404).json({ error: "Upload session not found" });
      }

      // Combines the ownership+in_progress check with the activity bump in
      // one atomic query: requesting a part URL is real evidence the
      // client is actively working this session, which is exactly what
      // uploadSweep.js's inactivity window (updated_at, not created_at)
      // needs to see so a legitimate hour-plus upload or a next-day resume
      // that's still progressing never gets swept mid-flight.
      const bumped = await client.query(
        `
        UPDATE video_uploads SET updated_at = now()
        WHERE session_id = $1 AND user_id = $2 AND status = 'in_progress'
        RETURNING *
        `,
        [sessionId, req.user.id]
      );
      let row = bumped.rows[0];

      if (!row) {
        const existing = await loadOwnedUpload(sessionId, req.user.id);
        if (!existing) {
          return res.status(404).json({ error: "Upload session not found" });
        }
        return res.status(409).json({ error: `Upload session is ${existing.status}, not in progress` });
      }

      if (!Number.isInteger(partNum) || partNum < 1 || partNum > row.part_count) {
        return res.status(400).json({ error: `partNumber must be between 1 and ${row.part_count}` });
      }

      const url = await storage.presignUploadPart(row.storage_key, row.r2_upload_id, partNum);
      res.json({ url, partNumber: partNum });
    } catch (err) {
      console.error("POST /api/video-uploads/:sessionId/parts/:partNumber/presign error:", err);
      res.status(500).json({ error: "Failed to sign part upload" });
    }
  }
);

// The one endpoint that needs a real transaction: two concurrent completion
// attempts for the same session (a retried client call, two tabs) must not
// race into creating two videos rows. SELECT ... FOR UPDATE takes a row
// lock on the video_uploads row for the lifetime of this transaction, so a
// second concurrent request blocks here until the first one commits (and
// then sees status='completed' and takes the idempotent-replay branch)
// rather than both reaching the INSERT below. Same BEGIN/COMMIT/ROLLBACK
// pattern already used by videos.js's DELETE handler.
router.post("/api/video-uploads/:sessionId/complete", authenticate, requireR2, async (req, res) => {
  const { sessionId } = req.params;
  const parts = Array.isArray(req.body.parts) ? req.body.parts : null;

  if (!parts || !parts.length) {
    return res.status(400).json({ error: "parts must be a non-empty array of {partNumber, etag}" });
  }

  if (!UUID_PATTERN.test(sessionId)) {
    return res.status(404).json({ error: "Upload session not found" });
  }

  const conn = await client.connect();

  try {
    await conn.query("BEGIN");

    const rowResult = await conn.query(
      "SELECT * FROM video_uploads WHERE session_id = $1 AND user_id = $2 FOR UPDATE",
      [sessionId, req.user.id]
    );
    const row = rowResult.rows[0];

    if (!row) {
      await conn.query("ROLLBACK");
      return res.status(404).json({ error: "Upload session not found" });
    }

    if (row.status === "aborted") {
      await conn.query("ROLLBACK");
      return res.status(409).json({ error: "Upload session was aborted" });
    }

    // Idempotent replay: a retried /complete call for an already-finished
    // session returns the same video row instead of erroring or inserting
    // a second one.
    if (row.status === "completed") {
      const videoResult = await conn.query("SELECT * FROM videos WHERE id = $1", [row.video_id]);
      await conn.query("COMMIT");
      return res.status(200).json(videoResult.rows[0]);
    }

    // Never trust the client's list blindly -- R2 itself rejects
    // CompleteMultipartUpload if a part/ETag doesn't match what it actually
    // has. That rejection IS the verification; there's no separate
    // pre-check to invent. On rejection, tell the client what's actually
    // missing (via a fresh ListParts) so it can retry only those parts.
    const r2Parts = parts
      .map((p) => ({ PartNumber: Number(p.partNumber), ETag: p.etag }))
      .sort((a, b) => a.partNumber - b.partNumber);

    try {
      await storage.completeMultipartUpload(row.storage_key, row.r2_upload_id, r2Parts);
    } catch (completeError) {
      console.error(`Complete failed for session ${sessionId}:`, completeError.message);
      const confirmedParts = await storage.listParts(row.storage_key, row.r2_upload_id);
      const confirmedNumbers = new Set(confirmedParts.map((p) => p.partNumber));
      const missingParts = [];
      for (let n = 1; n <= row.part_count; n += 1) {
        if (!confirmedNumbers.has(n)) missingParts.push(n);
      }

      await conn.query("ROLLBACK");
      return res.status(409).json({
        error: "Some parts are missing or invalid — retry only the listed parts",
        missingParts,
      });
    }

    // Belt-and-suspenders beyond R2's own per-part ETag validation: confirm
    // the final assembled object is genuinely the expected size before this
    // session is allowed to produce a videos row.
    const liveSize = await storage.getObjectSize(row.storage_key);
    if (liveSize !== Number(row.file_size)) {
      console.error(
        `Size mismatch after R2 completion for session ${sessionId}: expected ${row.file_size}, got ${liveSize}`
      );
      await conn.query("ROLLBACK");
      return res.status(500).json({ error: "Uploaded object size does not match expected file size" });
    }

    const videoInsert = await conn.query(
      `
      INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, source_size_bytes)
      VALUES ($1, $2, $3, 'uploading', $4, $5)
      RETURNING *
      `,
      [row.title, row.storage_key, req.user.id, row.team_id, row.file_size]
    );
    const video = videoInsert.rows[0];

    await conn.query(
      "UPDATE video_uploads SET status = 'completed', video_id = $1, updated_at = now() WHERE id = $2",
      [video.id, row.id]
    );

    await conn.query("COMMIT");

    // Same as videos.js's upload route: fire-and-forget, the client polls
    // GET /api/videos/:id for uploading -> classifying -> ready.
    classifyAndRouteAsync(video);

    await logSecurityEvent("video_upload_completed", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { sessionId, videoId: video.id, fileSize: Number(row.file_size) },
    });

    res.status(201).json(video);
  } catch (err) {
    await conn.query("ROLLBACK");
    console.error("POST /api/video-uploads/:sessionId/complete error:", err);
    res.status(500).json({ error: "Failed to complete upload" });
  } finally {
    conn.release();
  }
});

router.post("/api/video-uploads/:sessionId/abort", authenticate, requireR2, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const row = await loadOwnedUpload(sessionId, req.user.id);

    if (!row) {
      return res.status(404).json({ error: "Upload session not found" });
    }

    if (row.status === "completed") {
      return res.status(409).json({ error: "Upload already completed, cannot abort" });
    }

    if (row.status === "aborted") {
      return res.json({ success: true }); // already aborted -- idempotent no-op
    }

    await storage.abortMultipartUpload(row.storage_key, row.r2_upload_id);
    await client.query("UPDATE video_uploads SET status = 'aborted', updated_at = now() WHERE id = $1", [row.id]);

    await logSecurityEvent("video_upload_aborted", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { sessionId },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/video-uploads/:sessionId/abort error:", err);
    res.status(500).json({ error: "Failed to abort upload" });
  }
});

// The resume endpoint: returns the server/R2-authoritative view of what's
// actually landed, not a trust of whatever the client's own IndexedDB
// bookkeeping says (that could be stale, or partially evicted -- see
// uploadSessions.js on the client). Called after the user re-selects a file
// and its {name, size, type, lastModified} fingerprint matches the locally
// persisted session. Also bumps updated_at when the session is still
// in_progress -- checking in on a session (e.g. reopening the app to
// resume) is itself real activity for the sweep's purposes.
router.get("/api/video-uploads/:sessionId", authenticate, requireR2, async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!UUID_PATTERN.test(sessionId)) {
      return res.status(404).json({ error: "Upload session not found" });
    }

    const bumped = await client.query(
      `
      UPDATE video_uploads SET updated_at = now()
      WHERE session_id = $1 AND user_id = $2 AND status = 'in_progress'
      RETURNING *
      `,
      [sessionId, req.user.id]
    );
    const row = bumped.rows[0] || (await loadOwnedUpload(sessionId, req.user.id));

    if (!row) {
      return res.status(404).json({ error: "Upload session not found" });
    }

    const completedParts = row.status === "in_progress" ? await storage.listParts(row.storage_key, row.r2_upload_id) : [];

    res.json({
      uploadId: row.session_id,
      status: row.status,
      fileName: row.file_name,
      fileSize: Number(row.file_size),
      lastModified: row.last_modified ? Number(row.last_modified) : null,
      partSize: row.part_size,
      partCount: row.part_count,
      completedParts,
      videoId: row.video_id,
    });
  } catch (err) {
    console.error("GET /api/video-uploads/:sessionId error:", err);
    res.status(500).json({ error: "Failed to fetch upload session" });
  }
});

module.exports = router;
