const express = require("express");

const client = require("../db/client");
const { canAccessConversation } = require("../services/permissions");

const router = express.Router();

/* Foundation Sprint Phase 2: replaces the flat GET/POST /api/messages
   endpoints (removed, not kept alongside these — see the Phase 2 migration
   header for why running both would be a "parallel system"). The MVP UI
   still only ever shows one conversation, but the backend is now built
   for real: Conversations -> Conversation Participants -> Messages. */

router.get("/api/conversations", async (req, res) => {
  try {
    const { user_id } = req.query;

    const result = await client.query(
      user_id
        ? `
          SELECT conversations.*, teams.name AS team_name
          FROM conversations
          JOIN conversation_participants ON conversation_participants.conversation_id = conversations.id
          LEFT JOIN teams ON teams.id = conversations.team_id
          WHERE conversation_participants.user_id = $1
          ORDER BY conversations.id
          `
        : `
          SELECT conversations.*, teams.name AS team_name
          FROM conversations
          LEFT JOIN teams ON teams.id = conversations.team_id
          ORDER BY conversations.id
          `,
      user_id ? [user_id] : []
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/conversations error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

router.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!(await canAccessConversation(user_id, id))) {
      return res.status(403).json({ error: "Not a participant of this conversation" });
    }

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
});

router.post("/api/conversations/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { sender_id, username, role, body } = req.body;

    if (!username || !role || !body) {
      return res.status(400).json({ error: "Missing required message fields" });
    }

    if (!(await canAccessConversation(sender_id, id))) {
      return res.status(403).json({ error: "Not a participant of this conversation" });
    }

    const result = await client.query(
      `
      INSERT INTO messages (conversation_id, sender_id, username, role, body)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [id, sender_id || null, username, role, body]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/conversations/:id/messages error:", err);
    res.status(500).json({ error: "Failed to save message" });
  }
});

router.put("/api/conversations/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const result = await client.query(
      `
      UPDATE conversation_participants
      SET last_read_at = CURRENT_TIMESTAMP
      WHERE conversation_id = $1 AND user_id = $2
      RETURNING *
      `,
      [id, user_id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Not a participant of this conversation" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /api/conversations/:id/read error:", err);
    res.status(500).json({ error: "Failed to mark conversation read" });
  }
});

module.exports = router;
