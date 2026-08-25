/*
  schedule.js (routes) — Cresamor's single source of truth for team
  events. Same self-contained express.Router() shape as teams.js/
  invitations.js/conversations.js.

  Authorization follows this project's existing, already-proven
  team-scoped model exactly -- no new permission functions were added.
  View access is canAccessTeam (any active team_members row, any role).
  Management (create/edit/cancel/delete) is canManageTeam (active
  team_members row with role_on_team='coach' specifically) -- the same
  function that already gates invitations, member removal, and video
  team reassignment. Assistant Coach gets no Schedule-management
  exception here, matching the existing precedent that no part of this
  app grants Assistant Coach management authority anywhere.

  Security rule enforced throughout: for any operation on an EXISTING
  event, the event is loaded from the database first and its own
  team_id is what gets authorized against -- never a team_id supplied by
  the client (query/body/URL of a different route). This mirrors
  canDeleteVideo/acceptInvitation's existing "the server's own row is the
  only source of truth" discipline.
*/

const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireOwner } = require("../middleware/authorize");
const { canAccessTeam, canManageTeam } = require("../services/permissions");

const router = express.Router();

const VALID_EVENT_TYPES = ["practice", "competition", "meeting", "team_event", "other"];
const VALID_STATUSES = ["scheduled", "canceled"];

function isValidDate(value) {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

// GET /api/teams/:teamId/events — team Schedule, any active member (any
// role). Optional ?from=&to= (ISO strings) bound the date range so a
// month Calendar view doesn't ever need to download the team's entire
// history. Includes canceled events deliberately -- Schedule is
// supposed to visibly show "this was canceled," not silently omit it.
router.get("/api/teams/:teamId/events", authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { from, to } = req.query;

    if (!(await canAccessTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "Not authorized to view this team's schedule" });
    }

    const conditions = ["events.team_id = $1"];
    const params = [teamId];

    if (from && isValidDate(from)) {
      params.push(from);
      conditions.push(`events.starts_at >= $${params.length}`);
    }
    if (to && isValidDate(to)) {
      params.push(to);
      conditions.push(`events.starts_at <= $${params.length}`);
    }

    const result = await client.query(
      `
      SELECT events.*, teams.name AS team_name
      FROM events
      JOIN teams ON teams.id = events.team_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY events.starts_at ASC
      `,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/teams/:teamId/events error:", err);
    res.status(500).json({ error: "Failed to fetch team schedule" });
  }
});

// POST /api/teams/:teamId/events — create. canManageTeam on the URL's
// teamId IS the authorization boundary here (unlike PATCH/DELETE below,
// there's no existing row yet to load a team_id from) -- this is the
// same shape POST /api/teams/:teamId/invitations already uses.
router.post("/api/teams/:teamId/events", authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { event_type, title, description, location, starts_at, ends_at } = req.body;

    if (!(await canManageTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "Not authorized to manage this team's schedule" });
    }

    if (!event_type || !VALID_EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: "event_type must be one of: " + VALID_EVENT_TYPES.join(", ") });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    if (!isValidDate(starts_at)) {
      return res.status(400).json({ error: "starts_at is required and must be a valid date/time" });
    }
    if (ends_at && !isValidDate(ends_at)) {
      return res.status(400).json({ error: "ends_at must be a valid date/time if provided" });
    }
    if (ends_at && isValidDate(ends_at) && new Date(ends_at) < new Date(starts_at)) {
      return res.status(400).json({ error: "ends_at cannot be before starts_at" });
    }

    const result = await client.query(
      `
      INSERT INTO events (team_id, event_type, title, description, location, starts_at, ends_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [teamId, event_type, title.trim(), description || null, location || null, starts_at, ends_at || null, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/teams/:teamId/events error:", err);
    res.status(500).json({ error: "Failed to create event" });
  }
});

// GET /api/events/:id — single event detail (edit-form prefill, direct
// linking from Home). team_id comes from the loaded row, never the URL
// or any client input beyond the event's own id.
router.get("/api/events/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT events.*, teams.name AS team_name
      FROM events
      JOIN teams ON teams.id = events.team_id
      WHERE events.id = $1
      `,
      [id]
    );

    const event = result.rows[0];
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (!(await canAccessTeam(req.user.id, event.team_id))) {
      return res.status(403).json({ error: "Not authorized to view this event" });
    }

    res.json(event);
  } catch (err) {
    console.error("GET /api/events/:id error:", err);
    res.status(500).json({ error: "Failed to fetch event" });
  }
});

// PATCH /api/events/:id — edit (including cancel/uncancel via status).
// The event is loaded first specifically so canManageTeam runs against
// its OWN team_id -- a client can never authorize an edit by supplying a
// different team_id in the request body. team_id itself is not editable
// here (moving an event between teams is out of scope for this branch;
// not requested, and would need its own "must manage both teams"
// authorization question the way PATCH /api/videos/:id/team has).
router.patch("/api/events/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { event_type, title, description, location, starts_at, ends_at, status } = req.body;

    const existingResult = await client.query("SELECT * FROM events WHERE id = $1", [id]);
    const existing = existingResult.rows[0];
    if (!existing) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (!(await canManageTeam(req.user.id, existing.team_id))) {
      return res.status(403).json({ error: "Not authorized to manage this event" });
    }

    if (event_type !== undefined && !VALID_EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: "event_type must be one of: " + VALID_EVENT_TYPES.join(", ") });
    }
    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ error: "title cannot be empty" });
    }
    if (starts_at !== undefined && !isValidDate(starts_at)) {
      return res.status(400).json({ error: "starts_at must be a valid date/time" });
    }
    if (ends_at !== undefined && ends_at !== null && !isValidDate(ends_at)) {
      return res.status(400).json({ error: "ends_at must be a valid date/time" });
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status must be one of: " + VALID_STATUSES.join(", ") });
    }

    const next = {
      event_type: event_type !== undefined ? event_type : existing.event_type,
      title: title !== undefined ? title.trim() : existing.title,
      description: description !== undefined ? description : existing.description,
      location: location !== undefined ? location : existing.location,
      starts_at: starts_at !== undefined ? starts_at : existing.starts_at,
      ends_at: ends_at !== undefined ? ends_at : existing.ends_at,
      status: status !== undefined ? status : existing.status,
    };

    if (next.ends_at && new Date(next.ends_at) < new Date(next.starts_at)) {
      return res.status(400).json({ error: "ends_at cannot be before starts_at" });
    }

    const result = await client.query(
      `
      UPDATE events
      SET event_type = $1, title = $2, description = $3, location = $4,
          starts_at = $5, ends_at = $6, status = $7, updated_at = now()
      WHERE id = $8
      RETURNING *
      `,
      [next.event_type, next.title, next.description, next.location, next.starts_at, next.ends_at, next.status, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /api/events/:id error:", err);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// DELETE /api/events/:id — hard delete, for an event that should never
// have existed (distinct from Cancel, which is PATCH status='canceled'
// and preserves the record). Same load-then-authorize discipline as PATCH.
router.delete("/api/events/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const existingResult = await client.query("SELECT * FROM events WHERE id = $1", [id]);
    const existing = existingResult.rows[0];
    if (!existing) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (!(await canManageTeam(req.user.id, existing.team_id))) {
      return res.status(403).json({ error: "Not authorized to delete this event" });
    }

    await client.query("DELETE FROM events WHERE id = $1", [id]);

    res.json({ success: true, id: Number(id) });
  } catch (err) {
    console.error("DELETE /api/events/:id error:", err);
    res.status(500).json({ error: "Failed to delete event" });
  }
});

// GET /api/users/:id/upcoming-events — Home's ENTIRE data source. Purpose
// -built, not a generic "give me events and I'll filter client-side"
// endpoint -- Home must never download arbitrary events itself. Derives
// eligible teams from the caller's own LIVE active team_members rows
// (never trusts a client-supplied team list), globally sorts by
// starts_at across every one of those teams (no per-team reservation, no
// primary-team weighting), excludes canceled events (a canceled event
// must never occupy one of the "next 3" slots), and returns exactly the
// first 3. requireOwner("id") — same ownership middleware already
// proven on GET /api/users/:id/teams — so one user can never pull
// another user's Home feed by changing the id in the URL.
router.get("/api/users/:id/upcoming-events", authenticate, requireOwner("id"), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT events.*, teams.name AS team_name
      FROM events
      JOIN teams ON teams.id = events.team_id
      WHERE events.status = 'scheduled'
        AND events.starts_at >= now()
        AND events.team_id IN (
          SELECT team_id FROM team_members WHERE user_id = $1 AND revoked_at IS NULL
        )
      ORDER BY events.starts_at ASC
      LIMIT 3
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/users/:id/upcoming-events error:", err);
    res.status(500).json({ error: "Failed to fetch upcoming events" });
  }
});

module.exports = router;
