const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireOwner } = require("../middleware/authorize");

const router = express.Router();

router.post("/api/clips", authenticate, async (req, res) => {
  try {
    const { title, start_time, end_time, video_id } = req.body;

    if (!title || start_time === undefined || end_time === undefined || !video_id) {
      return res.status(400).json({ error: "Missing required clip fields" });
    }

    const result = await client.query(
      `
      INSERT INTO clips (title, start_time, end_time, video_id, user_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [title, start_time, end_time, video_id, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/clips error:", err);
    res.status(500).json({ error: "Failed to save clip" });
  }
});

// Beta permissions audit fix: no ownership check beyond authenticate —
// any logged-in user could enumerate another user's clip titles/video
// ids by changing :id. Every current caller (home.js, app.js's
// loadMyClips()) already only ever requests currentUser.id; confirmed by
// inspection — nothing legitimate breaks.
router.get("/api/users/:id/clips", authenticate, requireOwner("id"), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT clips.*
      FROM clips
      WHERE clips.user_id = $1
      ORDER BY clips.id DESC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/users/:id/clips error:", err);
    res.status(500).json({ error: "Failed to fetch user clips" });
  }
});

module.exports = router;
