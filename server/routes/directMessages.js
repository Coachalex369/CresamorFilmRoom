/*
  directMessages.js — Direct Messaging Phase 1: the two genuinely NEW
  endpoints this feature needs. Everything else (fetch/send/mark-read on
  an existing conversation) is handled unchanged by the existing
  server/routes/conversations.js endpoints — they already gate through
  requireConversationParticipant -> canAccessConversation, which now
  branches to canAccessDirectMessage for category='direct' conversations
  (see permissions.js). This file does not duplicate that.

  Never trusts a client-supplied recipient id as proof of eligibility --
  every request here re-derives eligibility server-side from live
  relationship data (permissions.js's isEligibleRecipientPair /
  getEligibleRecipients), the same functions the conversation-access
  check itself uses, so what a user is shown and what the server will
  actually authorize can never disagree.
*/
const express = require("express");

const { authenticate } = require("../middleware/authenticate");
const {
  canInitiateDirectMessage,
  resolveOrCreateDirectConversation,
  getEligibleRecipients,
} = require("../services/permissions");

const router = express.Router();

// "New Message" recipient list. No global directory, no free-text
// search across all Cresamor accounts -- only users the caller currently
// has a live, valid relationship with (shared coaching-staff team
// membership, or a parent_athlete_links row, direct or transitive via
// coaching staff). Returns display_name/role/context only -- never
// email or phone.
router.get("/api/messages/eligible-recipients", authenticate, async (req, res) => {
  try {
    const recipients = await getEligibleRecipients(req.user.id);
    res.json(recipients);
  } catch (err) {
    console.error("GET /api/messages/eligible-recipients error:", err);
    res.status(500).json({ error: "Failed to load eligible recipients" });
  }
});

// Resolves (or creates) the ONE canonical DM thread between the caller
// and the given recipient. Repeated calls, either order, return the same
// conversation -- see permissions.js's resolveOrCreateDirectConversation
// for the race-safety guarantee (a partial unique index on
// conversations.direct_pair_key, not just an application-level check-
// then-insert).
router.post("/api/direct-messages", authenticate, async (req, res) => {
  try {
    const recipientUserId = Number(req.body.recipient_user_id);

    if (!Number.isInteger(recipientUserId) || recipientUserId <= 0) {
      return res.status(400).json({ error: "Missing or invalid recipient_user_id" });
    }

    if (recipientUserId === Number(req.user.id)) {
      return res.status(400).json({ error: "Cannot start a direct message with yourself" });
    }

    // Creation uses the ASYMMETRIC, per-initiator check -- not the
    // broader isEligibleRecipientPair used for ongoing access -- so an
    // unlinked parent cannot spontaneously start a DM with a coach they
    // merely share a roster with, even though that same coach could
    // start one with them (see canInitiateDirectMessage's own header).
    const eligible = await canInitiateDirectMessage(req.user.id, recipientUserId);
    if (!eligible) {
      // Same reasoning as every other rejection path in this app that
      // touches identity/eligibility: a flat 403 with no detail, so this
      // endpoint can't be used to probe which user ids exist or which
      // relationships a target user has.
      return res.status(403).json({ error: "Not eligible to message this user" });
    }

    const conversation = await resolveOrCreateDirectConversation(req.user.id, recipientUserId);
    res.status(201).json(conversation);
  } catch (err) {
    console.error("POST /api/direct-messages error:", err);
    res.status(500).json({ error: "Failed to open direct message" });
  }
});

module.exports = router;
