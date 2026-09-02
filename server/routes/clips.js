const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireOwner } = require("../middleware/authorize");
const { canViewVideo, canViewVideosBatch } = require("../services/permissions");
const { lockAndAssertNotPurgePending } = require("../services/sourceRetention");
const { withPlaybackStatus } = require("../services/videoPlayback");

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
  const { title, start_time, end_time, video_id } = req.body;

  if (!title || start_time === undefined || end_time === undefined || !video_id) {
    return res.status(400).json({ error: "Missing required clip fields" });
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

    const result = await conn.query(
      `
      INSERT INTO clips (title, start_time, end_time, video_id, user_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [title, start_time, end_time, video_id, req.user.id]
    );

    await conn.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.error("POST /api/clips error:", err);
    res.status(500).json({ error: "Failed to save clip" });
  } finally {
    conn.release();
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
