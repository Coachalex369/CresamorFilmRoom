const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const client = require("../db/client");
const {
  enqueueVideoProcessingAsync,
  needsFormatConversion,
  retryConversion,
  MAX_AUTO_CONVERSION_SIZE_BYTES,
} = require("../services/videoProcessing");
const { canDeleteVideo, canViewVideo } = require("../services/permissions");
const storage = require("../services/storage/storage");
const { authenticate } = require("../middleware/authenticate");
const { uploadLimiter } = require("../middleware/rateLimiters");
const { logSecurityEvent } = require("../services/auditLog");

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

// Playback-fix pass: Render's /uploads disk is ephemeral and has already
// lost files across a redeploy once (see ARCHITECTURE.md's storage
// section). Rather than let the player discover that via a 404 mid-play,
// GET responses check file existence up front so the client can show a
// clear "unavailable" state instead of attempting playback. Only checked
// for local /uploads paths — external http(s) URLs are assumed reachable
// (no outbound request made here). This is the LEGACY path — rows from
// before the R2 migration, which never got a storage_key and keep using
// this exact logic indefinitely (see withPlaybackStatus below).
function isFileAvailable(fileUrl) {
  if (!fileUrl) return false;
  if (/^https?:\/\//i.test(fileUrl)) return true;

  const localPath = path.join(__dirname, "../..", fileUrl);
  return fs.existsSync(localPath);
}

// storage_key IS NOT NULL means this row goes through the storage
// abstraction (local disk or R2, whichever is active) — a signed/direct
// URL and a real existence check. NULL means a legacy row: unchanged
// file_url-based logic, forever, regardless of what STORAGE_PROVIDER is
// set to today.
async function withPlaybackStatus(video) {
  if (video.storage_key) {
    return {
      ...video,
      file_url: await storage.getSignedUrl(video.storage_key),
      available: await storage.exists(video.storage_key),
      needs_conversion: needsFormatConversion(video),
    };
  }

  return {
    ...video,
    available: isFileAvailable(video.file_url),
    needs_conversion: needsFormatConversion(video),
  };
}

function deleteLocalFileIfPresent(fileUrl) {
  if (!fileUrl || /^https?:\/\//i.test(fileUrl)) return;

  const localPath = path.join(__dirname, "../..", fileUrl);
  fs.unlink(localPath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("Failed to delete file:", localPath, err);
    }
  });
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
    const result = await client.query(
      `
      SELECT *
      FROM videos
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

    res.json(await withPlaybackStatus(result.rows[0]));
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

router.post("/api/upload-video", authenticate, uploadLimiter, upload.single("video"), async (req, res) => {
  try {
    const { title, team_id, film_type } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No video file uploaded" });
    }

    if (!title) {
      return res.status(400).json({ error: "Missing required upload fields" });
    }

    // Beta Readiness Sprint 1: new uploads always go through the storage
    // abstraction (storage_key set, file_url left NULL) — local disk or
    // R2, whichever STORAGE_PROVIDER is active. Legacy rows (storage_key
    // NULL) are untouched and keep using file_url forever; this is not a
    // migration of old rows, only where new ones land.
    //
    // Opaque key refinement: no original filename in the key — just an
    // organizational prefix (team/year) and a random UUID. team_id is
    // optional (the manual coach-upload path still doesn't collect one),
    // hence "unassigned" as a stable fallback segment rather than
    // conditionally omitting a path level.
    const extension = storage.extensionFor("video", req.file.mimetype);
    const year = new Date().getFullYear();
    const teamSegment = team_id || "unassigned";
    const storageKey = `videos/${teamSegment}/${year}/${crypto.randomUUID()}${extension}`;
    await storage.upload(storageKey, req.file.path, req.file.mimetype, { category: "video" });

    // Foundation Sprint Phase 1: team_id/film_type are now real columns —
    // capture.js sends them directly instead of Sprint 1's workaround of
    // folding them into the title string. Both stay optional since the
    // manual coach upload path still doesn't collect either.
    const inserted = await client.query(
      `
      INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, film_type)
      VALUES ($1, $2, $3, 'uploading', $4, $5)
      RETURNING *
      `,
      [title, storageKey, req.user.id, team_id || null, film_type || null]
    );

    // Foundation Sprint Phase 3: this route now only receives the upload —
    // it responds immediately instead of blocking on processing. The
    // client (capture.js) polls GET /api/videos/:id to observe
    // uploading -> queued -> converting -> ready. Deliberately NOT
    // awaited: conversion can take real time, and this request/response
    // contract already doesn't assume it's fast.
    //
    // Beta Stabilization Sprint: the size cap on automatic conversion is
    // decided right here, once, using req.file.size — multer already has
    // it, so this needs no extra I/O. 'deferred' is a distinct non-error
    // state (not 'failed') for a valid file that's simply too large for
    // the automatic queue on this beta instance; it skips the queue
    // entirely rather than risking tying it up for a very long time. A
    // manual retry (POST /api/videos/:id/retry-conversion) always
    // attempts conversion regardless of size.
    if (needsFormatConversion(inserted.rows[0]) && req.file.size > MAX_AUTO_CONVERSION_SIZE_BYTES) {
      await client.query(`UPDATE videos SET processing_status = 'deferred' WHERE id = $1`, [
        inserted.rows[0].id,
      ]);
      inserted.rows[0].processing_status = "deferred";
    } else {
      enqueueVideoProcessingAsync(inserted.rows[0]);
    }

    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    console.error("POST /api/upload-video error:", err);
    res.status(500).json({ error: "Failed to upload video" });
  }
});

// Video-delete pass, hardened in Beta Readiness Sprint 2: identity now
// comes from the verified JWT (req.user.id), not a client-supplied body
// field. Authorization logic (uploader-or-coach) is unchanged.
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

    const conn = await client.connect();

    try {
      await conn.query("BEGIN");
      await conn.query("DELETE FROM clips WHERE video_id = $1", [id]);
      await conn.query("DELETE FROM videos WHERE id = $1", [id]);
      await conn.query("COMMIT");
    } catch (txError) {
      await conn.query("ROLLBACK");
      throw txError;
    } finally {
      conn.release();
    }

    // Best-effort — the file may already be missing (that's often exactly
    // why this endpoint is being called), which isn't a deletion failure.
    // storage_key rows go through the active storage provider; legacy
    // rows (storage_key NULL) keep using the local-disk-only path.
    if (video.storage_key) {
      await storage.remove(video.storage_key);
    } else {
      deleteLocalFileIfPresent(video.file_url);
    }

    // Beta Stabilization Sprint: a converted video also has a retained
    // original (source_storage_key) — both objects belong to the same
    // video and must go together, never left orphaned in R2.
    if (video.source_storage_key && video.source_storage_key !== video.storage_key) {
      await storage.remove(video.source_storage_key);
    }

    deleteLocalFileIfPresent(video.thumbnail_url);

    await logSecurityEvent("video_deleted", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { videoId: Number(id), uploadedBy: video.uploaded_by },
    });

    res.json({ success: true, id: Number(id) });
  } catch (err) {
    console.error("DELETE /api/videos/:id error:", err);
    res.status(500).json({ error: "Failed to delete video" });
  }
});

// Beta Stabilization Sprint: the safe manual retry mechanism — what
// unsticks a video stuck in 'converting' (e.g. from a crash the boot-time
// auto-requeue hasn't caught yet), a genuinely 'failed' conversion, or a
// 'deferred' one exceeding the automatic size cap (retry always attempts
// it regardless of size). Same uploader-or-coach authority as delete —
// reused, not reinvented.
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

    await retryConversion(video.id);

    res.json({ success: true, id: Number(id), processing_status: "queued" });
  } catch (err) {
    console.error("POST /api/videos/:id/retry-conversion error:", err);
    res.status(500).json({ error: "Failed to retry conversion" });
  }
});

module.exports = router;
