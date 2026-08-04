const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const client = require("../db/client");
const {
  enqueueVideoProcessingAsync,
  needsFormatConversion,
} = require("../services/videoProcessing");
const { canDeleteVideo } = require("../services/permissions");
const storage = require("../services/storage/storage");

const router = express.Router();

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
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const upload = multer({ storage: tempStorage });

router.get("/api/videos", async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT *
      FROM videos
      ORDER BY id DESC
      `
    );

    res.json(await Promise.all(result.rows.map(withPlaybackStatus)));
  } catch (err) {
    console.error("GET /api/videos error:", err);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

// Foundation Sprint Phase 3: added so clients can poll a single video's
// processing_status after upload instead of re-fetching the whole list.
router.get("/api/videos/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query("SELECT * FROM videos WHERE id = $1", [id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Video not found" });
    }

    res.json(await withPlaybackStatus(result.rows[0]));
  } catch (err) {
    console.error("GET /api/videos/:id error:", err);
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

router.post("/api/videos", async (req, res) => {
  try {
    const { title, file_url, uploaded_by } = req.body;

    if (!title || !file_url || !uploaded_by) {
      return res.status(400).json({ error: "Missing required video fields" });
    }

    const result = await client.query(
      `
      INSERT INTO videos (title, file_url, uploaded_by)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [title, file_url, uploaded_by]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/videos error:", err);
    res.status(500).json({ error: "Failed to create video" });
  }
});

router.post("/api/upload-video", upload.single("video"), async (req, res) => {
  try {
    const { title, uploaded_by, team_id, film_type } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No video file uploaded" });
    }

    if (!title || !uploaded_by) {
      return res.status(400).json({ error: "Missing required upload fields" });
    }

    // Beta Readiness Sprint 1: new uploads always go through the storage
    // abstraction (storage_key set, file_url left NULL) — local disk or
    // R2, whichever STORAGE_PROVIDER is active. Legacy rows (storage_key
    // NULL) are untouched and keep using file_url forever; this is not a
    // migration of old rows, only where new ones land.
    const storageKey = `videos/${req.file.filename}`;
    await storage.upload(storageKey, req.file.path, req.file.mimetype);

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
      [title, storageKey, uploaded_by, team_id || null, film_type || null]
    );

    // Foundation Sprint Phase 3: this route now only receives the upload —
    // it responds immediately instead of blocking on processing. The
    // client (capture.js) polls GET /api/videos/:id to observe
    // uploading -> processing -> ready. Deliberately NOT awaited: when
    // real transcoding lands here and takes real time, this request/
    // response contract already doesn't assume it's fast.
    enqueueVideoProcessingAsync(inserted.rows[0]);

    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    console.error("POST /api/upload-video error:", err);
    res.status(500).json({ error: "Failed to upload video" });
  }
});

// Video-delete pass: authorization here is the same known-limited pattern
// as canAccessConversation — requesting_user_id is trusted from the
// request body because no route in this app verifies the JWT bearer token
// server-side yet (see CLAUDE.md's "Known architectural quirks"). This is
// still real access control (uploader-or-coach, checked against the DB),
// just not real authentication.
router.delete("/api/videos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const requestingUserId = req.body?.requesting_user_id;

    if (!requestingUserId) {
      return res.status(400).json({ error: "Missing requesting_user_id" });
    }

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const allowed = await canDeleteVideo(requestingUserId, id);

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
    deleteLocalFileIfPresent(video.thumbnail_url);

    res.json({ success: true, id: Number(id) });
  } catch (err) {
    console.error("DELETE /api/videos/:id error:", err);
    res.status(500).json({ error: "Failed to delete video" });
  }
});

module.exports = router;
