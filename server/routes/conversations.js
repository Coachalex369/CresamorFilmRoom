const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireConversationParticipant } = require("../middleware/authorize");
const { isEligibleRecipientPair } = require("../services/permissions");
const { safeSenderLabel, sanitizeMessageRows } = require("../services/messageLabels");

const router = express.Router();

/* Foundation Sprint Phase 2: replaces the flat GET/POST /api/messages
   endpoints (removed, not kept alongside these — see the Phase 2 migration
   header for why running both would be a "parallel system"). The MVP UI
   still only ever shows one conversation, but the backend is now built
   for real: Conversations -> Conversation Participants -> Messages. */

// Beta Readiness Sprint 2 bug fix: this used to trust an OPTIONAL
// user_id query param — omitting it returned every conversation in the
// system. Now always scoped to the authenticated caller, no override.
//
// Messages team-scoping fix: a category='team' conversation is now
// listed based on LIVE active team_members, matching
// permissions.js's canAccessConversation — not on a static
// conversation_participants row, which can drift out of sync with real
// team membership. Every other category still goes through the
// conversation_participants JOIN exactly as before, unchanged.
// Direct Messaging: this now also returns unread_count per conversation
// (reusing conversation_participants.last_read_at, unchanged schema) and,
// for category='direct' rows, an other_participant {id, display_name,
// role} -- never email/phone. A direct conversation whose relationship
// has since lapsed (team membership revoked, etc.) is filtered back out
// here -- same live-reevaluation rule canAccessDirectMessage enforces on
// the read/send side, so the inbox and unread badge never surface or
// count something the user could not actually open right now. History
// isn't deleted anywhere by this -- it just stops appearing in the list
// until/unless the relationship becomes valid again.
router.get("/api/conversations", authenticate, async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT DISTINCT conversations.*, teams.name AS team_name,
        (
          SELECT COUNT(*)::int FROM messages m
          WHERE m.conversation_id = conversations.id
            AND m.sender_id IS DISTINCT FROM $1
            AND m.created_at > COALESCE(
              (SELECT cp.last_read_at FROM conversation_participants cp
               WHERE cp.conversation_id = conversations.id AND cp.user_id = $1),
              'epoch'
            )
        ) AS unread_count,
        (
          SELECT m.body FROM messages m
          WHERE m.conversation_id = conversations.id
          ORDER BY m.created_at DESC LIMIT 1
        ) AS last_message_preview,
        (
          SELECT m.created_at FROM messages m
          WHERE m.conversation_id = conversations.id
          ORDER BY m.created_at DESC LIMIT 1
        ) AS last_message_at
      FROM conversations
      LEFT JOIN teams ON teams.id = conversations.team_id
      WHERE
        (
          conversations.category = 'team' AND conversations.team_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM team_members
            WHERE team_members.team_id = conversations.team_id
              AND team_members.user_id = $1
              AND team_members.revoked_at IS NULL
          )
        )
        OR (
          conversations.category IS DISTINCT FROM 'team'
          AND EXISTS (
            SELECT 1 FROM conversation_participants
            WHERE conversation_participants.conversation_id = conversations.id
              AND conversation_participants.user_id = $1
          )
        )
      ORDER BY conversations.id
      `,
      [req.user.id]
    );

    const conversations = result.rows;
    const directConversations = conversations.filter((c) => c.category === "direct");

    if (directConversations.length) {
      const conversationIds = directConversations.map((c) => c.id);

      const participantRows = await client.query(
        `
        SELECT cp.conversation_id, u.id, u.display_name, u.email, u.role
        FROM conversation_participants cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.conversation_id = ANY($1::int[]) AND cp.user_id != $2
        `,
        [conversationIds, req.user.id]
      );

      const otherByConversation = new Map(
        participantRows.rows.map((row) => [
          row.conversation_id,
          { id: row.id, display_name: row.display_name || row.email.split("@")[0], role: row.role },
        ])
      );

      const eligibility = await Promise.all(
        directConversations.map((c) => {
          const other = otherByConversation.get(c.id);
          return other ? isEligibleRecipientPair(req.user.id, other.id) : Promise.resolve(false);
        })
      );

      directConversations.forEach((c, i) => {
        c.other_participant = otherByConversation.get(c.id) || null;
        c.currently_eligible = eligibility[i];
      });
    }

    const visible = conversations.filter((c) => c.category !== "direct" || c.currently_eligible);

    res.json(visible);
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

      res.json(await sanitizeMessageRows(result.rows));
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
      //
      // Production privacy fix: this used to store display_name || email
      // -- most real accounts have no display_name set, so a real user's
      // real email was being permanently stored here and shown to every
      // other participant in the conversation. safeSenderLabel() never
      // falls back to email/phone -- see server/services/messageLabels.js.
      const userResult = await client.query(
        "SELECT display_name, role FROM users WHERE id = $1",
        [req.user.id]
      );
      const { display_name, role } = userResult.rows[0];
      const username = safeSenderLabel({ display_name, role });

      const result = await client.query(
        `
        INSERT INTO messages (conversation_id, sender_id, username, role, body)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [id, req.user.id, username, role, body]
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
