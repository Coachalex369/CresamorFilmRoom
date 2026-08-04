/*
  permissions.js — permission groundwork (Foundation Sprint Phase 2).

  This is deliberately small. The brief asks every request to eventually
  answer "should this user be allowed to see this resource?", inheriting
  through Organization -> School -> Team -> Conversation -> Resource. This
  file is the first real seam for that — it does NOT attempt to solve the
  bigger, pre-existing gap that no route in this app verifies the JWT
  bearer token server-side (see CLAUDE.md's "Known architectural quirks").
  That's a known, separate, larger piece of work. What this file adds is
  narrower and immediately real: given a claimed user_id, is that user
  actually a participant of the conversation they're trying to read/post
  to. That's genuine access control, just not authentication.

  As the Organization -> School -> Team hierarchy grows (Phase 3+), extend
  this file with more resource-specific checks (e.g. canAccessTeamFilm)
  rather than scattering ad-hoc permission queries through server/app.js.
*/

const client = require("../db/client");

async function canAccessConversation(userId, conversationId) {
  if (!userId || !conversationId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM conversation_participants
    WHERE user_id = $1 AND conversation_id = $2
    `,
    [userId, conversationId]
  );

  return result.rows.length > 0;
}

// Same caveat as canAccessConversation above: this trusts a client-supplied
// userId, since no route in the app verifies the JWT bearer token
// server-side yet (see CLAUDE.md). Real rule: the original uploader, or
// anyone with the 'coach' role, can delete a video.
async function canDeleteVideo(userId, videoId) {
  if (!userId || !videoId) return false;

  const result = await client.query(
    `
    SELECT videos.uploaded_by, users.role
    FROM videos, users
    WHERE videos.id = $1 AND users.id = $2
    `,
    [videoId, userId]
  );

  if (!result.rows.length) return false;

  const { uploaded_by, role } = result.rows[0];

  return role === "coach" || Number(uploaded_by) === Number(userId);
}

module.exports = { canAccessConversation, canDeleteVideo };
