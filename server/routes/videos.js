const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const client = require("../db/client");
const { enqueueVideoProcessingAsync } = require("../services/videoProcessing");

const router = express.Router();

const uploadsDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const upload = multer({ storage });

router.get("/api/videos", async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT *
      FROM videos
      ORDER BY id DESC
      `
    );

    res.json(result.rows);
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

    res.json(result.rows[0]);
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

    const fileUrl = `/uploads/${req.file.filename}`;

    // Foundation Sprint Phase 1: team_id/film_type are now real columns —
    // capture.js sends them directly instead of Sprint 1's workaround of
    // folding them into the title string. Both stay optional since the
    // manual coach upload path still doesn't collect either.
    const inserted = await client.query(
      `
      INSERT INTO videos (title, file_url, uploaded_by, processing_status, team_id, film_type)
      VALUES ($1, $2, $3, 'uploading', $4, $5)
      RETURNING *
      `,
      [title, fileUrl, uploaded_by, team_id || null, film_type || null]
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

module.exports = router;
