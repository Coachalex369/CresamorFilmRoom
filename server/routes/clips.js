const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireOwner } = require("../middleware/authorize");
const { canViewVideo } = require("../services/permissions");

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
router.post("/api/clips", authenticate, async (req, res) => {
  try {
    const { title, start_time, end_time, video_id } = req.body;

    if (!title || start_time === undefined || end_time === undefined || !video_id) {
      return res.status(400).json({ error: "Missing required clip fields" });
    }

    const videoResult = await client.query("SELECT * FROM videos WHERE id = $1", [video_id]);
    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!(await canViewVideo(req.user.id, video))) {
      return res.status(403).json({ error: "Not authorized to create a clip from this video" });
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
