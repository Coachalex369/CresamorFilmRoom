/*
  teamHighlights.js — Team Highlights, Slice 2. GET/POST/DELETE for the
  team-scoped "publish an existing eligible source" feed. team_highlights
  itself was created inert in Slice 1 (migration 018) — this file is the
  first thing that ever reads or writes it. No migration needed here; the
  schema already supports everything below.

  auditLog is required as a namespace object (`const auditLog = ...`),
  NOT destructured, specifically so a test can monkeypatch
  auditLog.logSecurityEvent for exactly one request and prove a mutation
  rolls back when the audit write fails — a destructured
  `const { logSecurityEvent } = ...` would bind a private copy at
  require-time that a later reassignment on the module object could never
  reach.
*/

const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { canAccessTeam, canManageTeamHighlights } = require("../services/permissions");
const sourceRetention = require("../services/sourceRetention");
const { withPlaybackStatus } = require("../services/videoPlayback");
const auditLog = require("../services/auditLog");

const router = express.Router();

// Explicit narrow SELECT -- not videos.*, not row_to_json(videos.*) -- so
// the sensitive/internal columns (storage_key, upload_destination,
// purge_status, film_removed_at, etc.) are never even fetched into
// memory for this route, on top of the explicit pick-list below that
// keeps them out of the response either way. Exactly the columns
// withPlaybackStatus needs to resolve file_url/available/playback_state
// (processing_status, storage_key, file_url) plus the public fields
// themselves.
const PUBLIC_VIDEO_COLUMNS = `
  videos.id, videos.title, videos.created_at, videos.uploaded_by, videos.team_id,
  videos.film_type, videos.thumbnail_url, videos.processing_status,
  videos.storage_key, videos.file_url
`;

// The one place this route ever turns a videos row into response JSON.
// withPlaybackStatus resolves file_url/available/playback_state (the
// same logic every other video-returning route already uses, including
// the legacy file_url-only path for pre-R2 rows); this then picks ONLY
// the approved public fields out of that result -- see the Slice 2 plan's
// "safe response shape" section. Never spreads the row, never includes
// storage_key, upload_destination, purge_status, film_removed_at/by,
// purge_reevaluation_requested_at, processing_error, video_codec,
// audio_codec, container, classification, or source_size_bytes.
async function serializeHighlightVideo(video) {
  const enriched = await withPlaybackStatus(video);
  return {
    id: enriched.id,
    title: enriched.title,
    created_at: enriched.created_at,
    uploaded_by: enriched.uploaded_by,
    team_id: enriched.team_id,
    film_type: enriched.film_type,
    thumbnail_url: enriched.thumbnail_url,
    file_url: enriched.file_url,
    available: enriched.available,
    playback_state: enriched.playback_state,
  };
}

// GET /api/teams/:teamId/highlights — active Team Highlights feed.
// Any active member (any role_on_team) may view; no admin bypass exists
// here because none is established anywhere else in the app for a
// team-scoped resource (see the Slice 2 plan's permission matrix).
router.get("/api/teams/:teamId/highlights", authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;

    if (!(await canAccessTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "You do not have an active membership on that team" });
    }

    const result = await client.query(
      `
      SELECT
        team_highlights.id, team_highlights.team_id, team_highlights.video_id,
        team_highlights.created_by, team_highlights.created_at,
        ${PUBLIC_VIDEO_COLUMNS}
      FROM team_highlights
      JOIN videos ON videos.id = team_highlights.video_id
      WHERE team_highlights.team_id = $1 AND team_highlights.removed_at IS NULL
      ORDER BY team_highlights.created_at DESC
      `,
      [teamId]
    );

    // INNER JOIN, not LEFT: an active post's video_id is guaranteed
    // non-null by team_highlights_active_needs_source, so every row here
    // genuinely has a video to resolve -- no null-video branch needed,
    // unlike clips.js's future-materialized-clip case.
    const enriched = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        team_id: row.team_id,
        video_id: row.video_id,
        created_by: row.created_by,
        created_at: row.created_at,
        video: await serializeHighlightVideo(row),
      }))
    );

    res.json(enriched);
  } catch (err) {
    console.error("GET /api/teams/:teamId/highlights error:", err);
    res.status(500).json({ error: "Failed to fetch team highlights" });
  }
});

// POST /api/teams/:teamId/highlights — publish an existing eligible
// source to that team. Coach or Assistant Coach only. Never trusts a
// body-supplied team_id -- the target team comes solely from the URL.
router.post("/api/teams/:teamId/highlights", authenticate, async (req, res) => {
  const { teamId } = req.params;
  const { video_id } = req.body;

  if (!video_id) {
    return res.status(400).json({ error: "video_id is required" });
  }

  // Checked before any transaction/lock is opened: this doesn't depend on
  // the video row at all, so a caller who was always going to be
  // rejected never costs a lock acquisition.
  if (!(await canManageTeamHighlights(req.user.id, teamId))) {
    return res.status(403).json({ error: "Not authorized to publish Team Highlights for this team" });
  }

  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    const video = await sourceRetention.lockVideoRow(conn, video_id);

    // Prevent source-existence leaks: every ineligible-source case --
    // missing entirely, Personal Film, another team's source, or
    // Film-removed -- collapses into the SAME generic 404, so a caller
    // can never learn which of those is actually true, or that a given
    // video_id exists at all if it belongs to someone else. purge_status
    // is checked ONLY after eligibility passes, and only then does a more
    // specific 409 apply -- by that point the caller has already proven
    // legitimate authority over a source that's already confirmed to be
    // theirs.
    const eligible =
      video &&
      Number(video.team_id) === Number(teamId) &&
      ["team_film", "team_highlights"].includes(video.upload_destination) &&
      video.film_removed_at === null;

    if (!eligible) {
      await conn.query("ROLLBACK");
      return res.status(404).json({ error: "Source not found or not eligible to publish" });
    }

    if (video.purge_status !== "active") {
      await conn.query("ROLLBACK");
      return res.status(409).json({ error: "This source is temporarily unavailable" });
    }

    // Race-safe, transaction-safe idempotency: a plain caught 23505 would
    // mark this whole transaction aborted (no further statements would
    // run without a SAVEPOINT). ON CONFLICT ... WHERE ... DO NOTHING
    // never raises an error on conflict at all -- it just returns zero
    // rows -- so the very next statement in this same transaction is
    // still safe to run. Verified directly against this exact partial
    // index shape before writing this route.
    const inserted = await conn.query(
      `
      INSERT INTO team_highlights (video_id, team_id, created_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (team_id, video_id) WHERE removed_at IS NULL DO NOTHING
      RETURNING *
      `,
      [video_id, teamId, req.user.id]
    );

    let post;
    let statusCode;
    let isFreshPublish;

    if (inserted.rows.length > 0) {
      post = inserted.rows[0];
      statusCode = 201;
      isFreshPublish = true;
    } else {
      const existing = await conn.query(
        "SELECT * FROM team_highlights WHERE team_id = $1 AND video_id = $2 AND removed_at IS NULL",
        [teamId, video_id]
      );
      post = existing.rows[0];
      statusCode = 200;
      isFreshPublish = false;
    }

    // Audit only the real state change -- never the idempotent replay.
    // Runs on this same conn: a real publish's post row and its audit row
    // commit or roll back together (see auditLog.js's own header for the
    // conn-aware contract this depends on).
    if (isFreshPublish) {
      await auditLog.logSecurityEvent("team_highlight_published", {
        userId: req.user.id,
        ip: req.ip,
        metadata: { teamHighlightId: post.id, videoId: Number(video_id), teamId: Number(teamId) },
        conn,
      });
    }

    await conn.query("COMMIT");

    res.status(statusCode).json({
      id: post.id,
      team_id: post.team_id,
      video_id: post.video_id,
      created_by: post.created_by,
      created_at: post.created_at,
      removed_at: post.removed_at,
      video: await serializeHighlightVideo(video),
    });
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.error("POST /api/teams/:teamId/highlights error:", err);
    res.status(500).json({ error: "Failed to publish Team Highlight" });
  } finally {
    conn.release();
  }
});

// DELETE /api/teams/:teamId/highlights/:highlightId — logically remove
// the post. Never deletes the source video, clips, or R2 object directly
// -- at most, marks the source for the existing Slice 1 sweeper to
// reconsider, and only when that's actually meaningful (see below).
router.delete("/api/teams/:teamId/highlights/:highlightId", authenticate, async (req, res) => {
  const { teamId, highlightId } = req.params;

  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    // Locked BEFORE any other read, scoped to BOTH highlightId and
    // teamId in one WHERE clause -- a highlight id from a different team
    // never matches, active or removed, so it 404s with zero information
    // leaked about whether it exists elsewhere. FOR UPDATE OF
    // team_highlights (not a bare FOR UPDATE) because this is a LEFT
    // JOIN -- Postgres refuses to lock the nullable side of an outer
    // join, and video_id genuinely can be NULL here for an
    // already-removed historical post whose source was later purged.
    const result = await conn.query(
      `
      SELECT
        team_highlights.id, team_highlights.team_id, team_highlights.video_id,
        team_highlights.created_by, team_highlights.created_at,
        team_highlights.removed_at, team_highlights.removed_by,
        videos.uploaded_by AS source_uploaded_by,
        videos.film_removed_at AS source_film_removed_at
      FROM team_highlights
      LEFT JOIN videos ON videos.id = team_highlights.video_id
      WHERE team_highlights.id = $1 AND team_highlights.team_id = $2
      FOR UPDATE OF team_highlights
      `,
      [highlightId, teamId]
    );

    const post = result.rows[0];
    if (!post) {
      await conn.query("ROLLBACK");
      return res.status(404).json({ error: "Team Highlight not found" });
    }

    if (post.removed_at !== null) {
      // Idempotent no-op branch. If video_id is still present, the
      // source hasn't been purged yet and the uploader-or-staff rule is
      // still fully verifiable -- apply it normally. Once video_id is
      // NULL (the source was independently purged since this post was
      // removed), uploaded_by is gone; this branch never pretends to
      // reconstruct that claim, so it requires staff authority only.
      // Either way, a repeat request changes nothing and creates no
      // audit event.
      const authorized =
        post.video_id !== null
          ? Number(post.source_uploaded_by) === Number(req.user.id) || (await canManageTeamHighlights(req.user.id, teamId))
          : await canManageTeamHighlights(req.user.id, teamId);

      if (!authorized) {
        await conn.query("ROLLBACK");
        return res.status(403).json({ error: "Not authorized to remove this Team Highlight" });
      }

      await conn.query("COMMIT");
      return res.json({
        id: post.id,
        team_id: post.team_id,
        video_id: post.video_id,
        removed_at: post.removed_at,
        removed_by: post.removed_by,
      });
    }

    // Active post -- video_id is guaranteed non-null here
    // (team_highlights_active_needs_source).
    const authorized =
      Number(post.source_uploaded_by) === Number(req.user.id) || (await canManageTeamHighlights(req.user.id, teamId));

    if (!authorized) {
      await conn.query("ROLLBACK");
      return res.status(403).json({ error: "Not authorized to remove this Team Highlight" });
    }

    const updated = await conn.query(
      "UPDATE team_highlights SET removed_at = now(), removed_by = $1 WHERE id = $2 RETURNING *",
      [req.user.id, highlightId]
    );

    // Preserve Film sources: a Team Highlight post is only ONE possible
    // reference. Removing it must never, by itself, make a source that's
    // still visible in Film eligible for physical purge -- only ask the
    // sweeper to reconsider when the source is ALREADY out of Film
    // (film_removed_at set). If it's still in Film, this request stops
    // here: the post is gone, the source and its R2 object are
    // completely untouched, not even marked.
    if (post.source_film_removed_at !== null) {
      await conn.query(sourceRetention.markForPurgeReevaluationSql(), [post.video_id]);
    }

    // Same conn as the mutation above -- see auditLog.js's conn-aware
    // contract. A failure here rolls back removed_at/removed_by AND the
    // reevaluation mark together, never leaving a partial state.
    await auditLog.logSecurityEvent("team_highlight_removed", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { teamHighlightId: post.id, videoId: post.video_id, teamId: Number(teamId) },
      conn,
    });

    await conn.query("COMMIT");

    res.json(updated.rows[0]);
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.error("DELETE /api/teams/:teamId/highlights/:highlightId error:", err);
    res.status(500).json({ error: "Failed to remove Team Highlight" });
  } finally {
    conn.release();
  }
});

module.exports = router;
