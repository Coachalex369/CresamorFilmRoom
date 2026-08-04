const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireConversationParticipant } = require("../middleware/authorize");

const router = express.Router();

/* Foundation Sprint Phase 2: replaces the flat GET/POST /api/messages
   endpoints (removed, not kept alongside these — see the Phase 2 migration
   header for why running both would be a "parallel system"). The MVP UI
   still only ever shows one conversation, but the backend is now built
   for real: Conversations -> Conversation Participants -> Messages. */

// Beta Readiness Sprint 2 bug fix: this used to trust an OPTIONAL
// user_id query param — omitting it returned every conversation in the
// system. Now always scoped to the authenticated caller, no override.
router.get("/api/conversations", authenticate, async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT conversations.*, teams.name AS team_name
      FROM conversations
      JOIN conversation_participants ON conversation_participants.conversation_id = conversations.id
      LEFT JOIN teams ON teams.id = conversations.team_id
      WHERE conversation_participants.user_id = $1
      ORDER BY conversations.id
      `,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/conversations error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

router.get(
  "/api/conversations/:id/messages",
  authenticate,
  requireConversationParticipant("id"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await client.query(
        `
        SELECT *
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        `,
        [id]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("GET /api/conversations/:id/messages error:", err);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  }
);

router.post(
  "/api/conversations/:id/messages",
  authenticate,
  requireConversationParticipant("id"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { body } = req.body;

      if (!body) {
        return res.status(400).json({ error: "Missing required message fields" });
      }

      // username/role used to come straight from the request body — a
      // free-text "type any name" field the client used to show (removed
      // in this sprint, see client/index.html) — now looked up server-side
      // from the authenticated user's real row so a caller can't post a
      // message under a fabricated name/role.
      const userResult = await client.query(
        "SELECT display_name, email, role FROM users WHERE id = $1",
        [req.user.id]
      );
      const { display_name, email, role } = userResult.rows[0];

      const result = await client.query(
        `
        INSERT INTO messages (conversation_id, sender_id, username, role, body)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [id, req.user.id, display_name || email, role, body]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("POST /api/conversations/:id/messages error:", err);
      res.status(500).json({ error: "Failed to save message" });
    }
  }
);

router.put(
  "/api/conversations/:id/read",
  authenticate,
  requireConversationParticipant("id"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await client.query(
        `
        UPDATE conversation_participants
        SET last_read_at = CURRENT_TIMESTAMP
        WHERE conversation_id = $1 AND user_id = $2
        RETURNING *
        `,
        [id, req.user.id]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error("PUT /api/conversations/:id/read error:", err);
      res.status(500).json({ error: "Failed to mark conversation read" });
    }
  }
);

module.exports = router;
