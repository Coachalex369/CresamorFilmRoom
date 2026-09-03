/*
  permissions.js — permission groundwork (Foundation Sprint Phase 2),
  extended in Beta Readiness Sprint 2 (server-side auth). Every function
  here now runs against req.user.id, supplied by middleware/authenticate.js
  after verifying a JWT — not a client-claimed body/query field anymore.

  As the Organization -> School -> Team hierarchy grows, extend this file
  with more resource-specific checks rather than scattering ad-hoc
  permission queries through the route files.
*/

const client = require("../db/client");

// Messages team-scoping fix: a category='team' conversation's
// authorization is derived LIVE from active team_members, not from the
// conversation_participants table -- that table is retained only for
// last_read_at/unread bookkeeping now, never the access boundary for a
// team conversation. This is what makes team revocation instantly cut
// off message GET/POST access, the same guarantee canAccessTeam already
// provides everywhere else in the app; a stale or missing
// conversation_participants row can no longer leak access to a former
// member OR incorrectly block a current one.
//
// Deliberately gated on category === 'team' specifically, not merely
// "team_id is non-null" -- a future coach/parent/athlete/direct
// conversation may carry a team_id purely for context (e.g. "this is a
// parent thread about a player on Team X") without meaning every member
// of Team X should see it. Only the real team-wide conversation gets the
// broad team-membership check; every other category keeps the original,
// narrower participant-row model regardless of what team_id it carries.
async function canAccessConversation(userId, conversationId) {
  if (!userId || !conversationId) return false;

  const conversationResult = await client.query(
    `SELECT team_id, category FROM conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return false;

  if (conversation.category === "team" && conversation.team_id !== null) {
    return canAccessTeam(userId, conversation.team_id);
  }

  // Direct Messaging: same "reevaluate live, don't trust a stale row"
  // discipline as the category='team' branch above, not the older static
  // participant-row model every other (currently unused) category below
  // still uses. A conversation_participants row still identifies WHO the
  // two people in the thread are (immutable thread identity, set once at
  // creation) but no longer alone proves they're CURRENTLY allowed to use
  // it — see canAccessDirectMessage.
  if (conversation.category === "direct") {
    return canAccessDirectMessage(userId, conversationId);
  }

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

// Direct Messaging — the live relationship check, shared by three call
// sites: canAccessDirectMessage (read/send/mark-read on an EXISTING
// thread), the eligible-recipients list, and POST /api/direct-messages
// (creating/resolving a NEW thread). One symmetric boolean query so the
// three call sites can never silently drift apart from each other. Three
// relationship types, all live (never a stale/static row alone):
//   1. Shared active team membership where at least one side is
//      coach/assistant_coach — covers the "COACH" rule directly, and
//      lets a parent/athlete/teammate message that coaching staff.
//   2. A parent_athlete_links row, either direction (parent<->athlete).
//   3. A parent and their linked athlete's own coaching staff, either
//      direction (parent<->athlete's coaches) — the transitive rule.
// parent_athlete_links is empty until Roster Profiles populates it, so
// (2) and (3) are correctly inert (not unsafely open) until then.
// Asymmetric, per-initiator: "can fromUserId proactively start/reach
// toUserId", mirroring each role's OWN literal rule rather than a
// symmetric pair fact. This is deliberately NOT the same question as
// "can these two people use an existing conversation" (see
// isEligibleRecipientPair below) -- a Coach's broad reach to their whole
// roster (including a not-yet-linked parent) is real and should let the
// Coach initiate, but that same unlinked parent must not be able to
// reach the Coach on their own; only a parent_athlete_links row grants a
// parent that reach, directly or via their athlete's coaching staff.
async function canInitiateDirectMessage(fromUserId, toUserId) {
  if (!fromUserId || !toUserId || Number(fromUserId) === Number(toUserId)) return false;

  const result = await client.query(
    `
    SELECT (
      -- fromUser is coach/assistant_coach on a team; toUser is any other
      -- active member of that same team (Coach's own broad rule).
      EXISTS (
        SELECT 1 FROM team_members mine
        JOIN team_members other ON other.team_id = mine.team_id AND other.revoked_at IS NULL
        WHERE mine.user_id = $1 AND other.user_id = $2
          AND mine.revoked_at IS NULL AND mine.role_on_team IN ('coach', 'assistant_coach')
      )
      -- fromUser is an athlete; toUser is coach/assistant_coach on that
      -- SAME team (Athlete's own rule reaching their team's coaching
      -- staff). A bare 'parent' row never satisfies this branch.
      OR EXISTS (
        SELECT 1 FROM team_members mine
        JOIN team_members other ON other.team_id = mine.team_id AND other.revoked_at IS NULL
        WHERE mine.user_id = $1 AND other.user_id = $2
          AND mine.revoked_at IS NULL AND mine.role_on_team = 'athlete'
          AND other.role_on_team IN ('coach', 'assistant_coach')
      )
      -- Direct parent<->athlete link, either direction -- both roles'
      -- own stated rule explicitly grants this (Parent: "their linked
      -- athletes"; Athlete: "their linked parent/guardian(s)").
      OR EXISTS (
        SELECT 1 FROM parent_athlete_links pal
        WHERE pal.revoked_at IS NULL
          AND ((pal.parent_user_id = $1 AND pal.athlete_user_id = $2)
            OR (pal.athlete_user_id = $1 AND pal.parent_user_id = $2))
      )
      -- fromUser is a parent linked to an athlete who is an active
      -- member of a team where toUser is active coaching staff
      -- (Parent's own rule: "coaches associated with those athlete/team
      -- relationships").
      OR EXISTS (
        SELECT 1 FROM parent_athlete_links pal
        JOIN team_members tm_athlete
          ON tm_athlete.user_id = pal.athlete_user_id AND tm_athlete.revoked_at IS NULL
        JOIN team_members tm_coach
          ON tm_coach.team_id = tm_athlete.team_id AND tm_coach.revoked_at IS NULL
          AND tm_coach.role_on_team IN ('coach', 'assistant_coach')
        WHERE pal.parent_user_id = $1 AND pal.revoked_at IS NULL AND tm_coach.user_id = $2
      )
    ) AS eligible
    `,
    [fromUserId, toUserId]
  );

  return Boolean(result.rows[0]?.eligible);
}

// Symmetric pair check: "is this DM still usable by BOTH participants
// right now." Deliberately broader than canInitiateDirectMessage in
// either single direction -- once a conversation has been legitimately
// created (by whichever side's own rule permitted it), both sides need
// to be able to read/reply, or a Coach messaging an unlinked parent
// would create a one-way mailbox the parent can't respond to. Used by
// canAccessDirectMessage (ongoing read/send/mark-read on an EXISTING
// conversation) -- NOT used to gate creation of a NEW one; that's
// canInitiateDirectMessage's job specifically, via POST
// /api/direct-messages, so an unlinked parent still cannot be the one to
// spontaneously start that conversation.
async function isEligibleRecipientPair(userIdA, userIdB) {
  if (!userIdA || !userIdB || Number(userIdA) === Number(userIdB)) return false;

  const [aToB, bToA] = await Promise.all([
    canInitiateDirectMessage(userIdA, userIdB),
    canInitiateDirectMessage(userIdB, userIdA),
  ]);

  return aToB || bToA;
}

// A direct conversation's two conversation_participants rows are its
// immutable thread identity (who this DM is between, set once at
// creation — see resolveOrCreateDirectConversation). Access itself is
// NOT granted by that row alone: it requires the caller to be one of the
// two AND the pair to still be isEligibleRecipientPair() right now. A
// malformed/legacy direct conversation with != 2 participants is denied
// rather than guessed at.
async function canAccessDirectMessage(userId, conversationId) {
  if (!userId || !conversationId) return false;

  const participantsResult = await client.query(
    `SELECT user_id FROM conversation_participants WHERE conversation_id = $1`,
    [conversationId]
  );
  const participantIds = participantsResult.rows.map((row) => Number(row.user_id));

  if (!participantIds.includes(Number(userId))) return false;
  if (participantIds.length !== 2) return false;

  const otherUserId = participantIds.find((id) => id !== Number(userId));
  return isEligibleRecipientPair(userId, otherUserId);
}

function directPairKey(userIdA, userIdB) {
  const [lo, hi] = [Number(userIdA), Number(userIdB)].sort((a, b) => a - b);
  return `${lo}_${hi}`;
}

// Canonical-thread resolution: always returns the SAME conversation row
// for a given unordered pair, creating it only if it doesn't exist yet.
// Race-safety is a database guarantee, not an application one — two
// concurrent calls for the same pair both attempt the INSERT, the
// partial unique index on conversations.direct_pair_key (migration 017)
// lets exactly one succeed, and the loser catches the resulting unique-
// violation (Postgres 23505) and re-selects the winner's row rather than
// erroring. Does not itself check isEligibleRecipientPair -- callers
// (the POST /api/direct-messages route) authorize before calling this;
// this function's only job is canonical identity, not authorization.
async function resolveOrCreateDirectConversation(userId, otherUserId) {
  const pairKey = directPairKey(userId, otherUserId);

  const existing = await client.query(
    `SELECT * FROM conversations WHERE category = 'direct' AND direct_pair_key = $1`,
    [pairKey]
  );
  if (existing.rows.length) return existing.rows[0];

  try {
    const created = await client.query(
      `INSERT INTO conversations (category, direct_pair_key) VALUES ('direct', $1) RETURNING *`,
      [pairKey]
    );
    const conversation = created.rows[0];

    await client.query(
      `
      INSERT INTO conversation_participants (conversation_id, user_id)
      VALUES ($1, $2), ($1, $3)
      ON CONFLICT (conversation_id, user_id) DO NOTHING
      `,
      [conversation.id, userId, otherUserId]
    );

    return conversation;
  } catch (err) {
    if (err.code === "23505") {
      const retry = await client.query(
        `SELECT * FROM conversations WHERE category = 'direct' AND direct_pair_key = $1`,
        [pairKey]
      );
      if (retry.rows.length) return retry.rows[0];
    }
    throw err;
  }
}

function addEligibleRecipient(map, { id, displayName, email, role, context }) {
  const label = displayName || (email ? email.split("@")[0] : "User");

  if (map.has(id)) {
    const existing = map.get(id);
    if (!existing.context.includes(context)) existing.context.push(context);
    return;
  }

  map.set(id, { id, display_name: label, role, context: [context] });
}

// Direct Messaging "New Message" recipient list. Deliberately NOT a
// global directory (see permissions.js file header + the Direct
// Messaging architecture proposal) -- built from the exact same
// per-initiator rules canInitiateDirectMessage checks (mine = the
// viewer, so this is intentionally asymmetric: a Coach's list includes
// their whole roster including not-yet-linked parents, but an unlinked
// Parent's own list will NOT include their team's coach -- only a real
// parent_athlete_links row grants that, direct or via the linked
// athlete's coaching staff). Never returns email/phone -- display_name
// (or a safe email-local-part fallback, matching the pattern used
// elsewhere in this app) and role only. `context` is a list of
// human-readable reasons (team name(s) / "your athlete" / "your
// parent/guardian") since the same person can be reachable via more than
// one relationship at once (multi-team users).
async function getEligibleRecipients(userId) {
  const recipients = new Map();

  const teamRows = await client.query(
    `
    SELECT DISTINCT other.user_id AS id, u.display_name, u.email, u.role, t.name AS team_name
    FROM team_members mine
    JOIN team_members other
      ON other.team_id = mine.team_id AND other.revoked_at IS NULL AND other.user_id != mine.user_id
    JOIN teams t ON t.id = mine.team_id
    JOIN users u ON u.id = other.user_id
    WHERE mine.user_id = $1 AND mine.revoked_at IS NULL
      AND (
        mine.role_on_team IN ('coach', 'assistant_coach')
        OR (mine.role_on_team = 'athlete' AND other.role_on_team IN ('coach', 'assistant_coach'))
      )
    `,
    [userId]
  );
  teamRows.rows.forEach((row) =>
    addEligibleRecipient(recipients, {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      context: `via ${row.team_name}`,
    })
  );

  const parentToAthlete = await client.query(
    `
    SELECT u.id, u.display_name, u.email, u.role
    FROM parent_athlete_links pal
    JOIN users u ON u.id = pal.athlete_user_id
    WHERE pal.parent_user_id = $1 AND pal.revoked_at IS NULL
    `,
    [userId]
  );
  parentToAthlete.rows.forEach((row) =>
    addEligibleRecipient(recipients, {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      context: "your athlete",
    })
  );

  const athleteToParent = await client.query(
    `
    SELECT u.id, u.display_name, u.email, u.role
    FROM parent_athlete_links pal
    JOIN users u ON u.id = pal.parent_user_id
    WHERE pal.athlete_user_id = $1 AND pal.revoked_at IS NULL
    `,
    [userId]
  );
  athleteToParent.rows.forEach((row) =>
    addEligibleRecipient(recipients, {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      context: "your parent/guardian",
    })
  );

  const parentToAthleteCoaches = await client.query(
    `
    SELECT DISTINCT u.id, u.display_name, u.email, u.role, t.name AS team_name
    FROM parent_athlete_links pal
    JOIN team_members tm_athlete ON tm_athlete.user_id = pal.athlete_user_id AND tm_athlete.revoked_at IS NULL
    JOIN team_members tm_coach
      ON tm_coach.team_id = tm_athlete.team_id AND tm_coach.revoked_at IS NULL
      AND tm_coach.role_on_team IN ('coach', 'assistant_coach')
    JOIN teams t ON t.id = tm_athlete.team_id
    JOIN users u ON u.id = tm_coach.user_id
    WHERE pal.parent_user_id = $1 AND pal.revoked_at IS NULL
    `,
    [userId]
  );
  parentToAthleteCoaches.rows.forEach((row) =>
    addEligibleRecipient(recipients, {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      context: `coach via ${row.team_name}`,
    })
  );

  const coachToAthleteParents = await client.query(
    `
    SELECT DISTINCT u.id, u.display_name, u.email, u.role, t.name AS team_name
    FROM team_members mine
    JOIN team_members tm_athlete ON tm_athlete.team_id = mine.team_id AND tm_athlete.revoked_at IS NULL
    JOIN parent_athlete_links pal ON pal.athlete_user_id = tm_athlete.user_id AND pal.revoked_at IS NULL
    JOIN teams t ON t.id = mine.team_id
    JOIN users u ON u.id = pal.parent_user_id
    WHERE mine.user_id = $1 AND mine.revoked_at IS NULL AND mine.role_on_team IN ('coach', 'assistant_coach')
    `,
    [userId]
  );
  coachToAthleteParents.rows.forEach((row) =>
    addEligibleRecipient(recipients, {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      context: `parent via ${row.team_name}`,
    })
  );

  return Array.from(recipients.values());
}

// Beta permissions audit fix: this used to be "the original uploader, or
// ANY user with the global users.role='coach'" — which let a coach
// managing Team A delete (or force-reprocess, via retry-conversion/
// retry-classification, which both reuse this same check) a video
// belonging to a completely unrelated Team B, just by knowing/guessing
// its numeric id. Team-scoped video *visibility* (canViewVideo) already
// doesn't work this way; management shouldn't either. Now: the uploader
// can always manage their own video (unconditional, matching
// canViewVideo's existing unconditional uploader check); for an
// assigned video (team_id NOT NULL), management requires real per-team
// authority via canManageTeam — global coach role alone is no longer
// sufficient. Unassigned-video authorization fix (Personal Film): for an
// unassigned video (team_id NULL), the former "any global coach" fallback
// let ANY coach anywhere in the system view/manage/delete ANY uploader's
// personal recording — confirmed via a real production incident (Chad's
// two Samsung/Android uploads, both unassigned, both reachable by every
// other coach account). Personal Film is uploader-private: only the
// uploader (checked above, unconditional) or a Platform Admin
// (users.is_platform_admin, a real DB-backed designation entirely
// separate from role — see migration 014) may act on it. Mirrors
// canViewVideo's identical team_id===null branch below; deliberately
// checked here via a second query rather than threading is_platform_admin
// through the same row (keeps this function's existing single-query shape
// for the common case, only pays for the second lookup on the rarer
// non-uploader path).
async function canDeleteVideo(userId, videoId) {
  if (!userId || !videoId) return false;

  const result = await client.query(
    `
    SELECT videos.uploaded_by, videos.team_id
    FROM videos
    WHERE videos.id = $1
    `,
    [videoId]
  );

  if (!result.rows.length) return false;

  const { uploaded_by, team_id } = result.rows[0];

  if (Number(uploaded_by) === Number(userId)) return true;

  if (team_id === null) {
    const admin = await client.query("SELECT is_platform_admin FROM users WHERE id = $1", [userId]);
    return admin.rows[0]?.is_platform_admin === true;
  }

  return canManageTeam(userId, team_id);
}

// Closed Beta Readiness Sprint: team-scoped access requires a real,
// active team_members row — the former "any coach can access any team"
// blanket shortcut was removed. An unrelated coach must not see another
// team's private roster or Team Film merely because their global
// users.role is 'coach'; only a genuine (non-revoked) membership counts,
// same rule for every role. See canManageTeam below for the (already
// narrower, already membership-scoped) management-action check.
async function canAccessTeam(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1 AND team_id = $2 AND revoked_at IS NULL
    `,
    [userId, teamId]
  );

  return result.rows.length > 0;
}

// Teams MVP: gates team-MANAGEMENT actions (create invitation, revoke a
// member). "Coaches may manage only teams assigned to them" means an
// active team_members row on THAT team with role_on_team = 'coach', not
// just users.role === 'coach' in general. POST /api/teams auto-inserts
// this row for the creator, so a coach can always manage a team they
// just created.
async function canManageTeam(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1 AND team_id = $2 AND role_on_team = 'coach' AND revoked_at IS NULL
    `,
    [userId, teamId]
  );

  return result.rows.length > 0;
}

// Teams MVP: the roster/team-detail read path. Same access shape as
// canAccessTeam (active membership required) — reused directly rather
// than duplicated, since viewing the roster is a read, not a management
// action (that's canManageTeam above).
async function canViewTeamRoster(userId, teamId) {
  return canAccessTeam(userId, teamId);
}

// Team Highlights, Slice 2: publish/moderate authority for a team's
// Highlights feed. Deliberately NOT canManageTeam (that's role_on_team =
// 'coach' only) -- the approved model is Coach OR Assistant Coach, same
// coaching-staff bar already established for reaching a team's whole
// roster in canInitiateDirectMessage's own SQL. A separate function
// rather than widening canManageTeam, since canManageTeam's existing
// callers (team reassignment, invitation creation, membership
// management) were deliberately scoped coach-only and changing that
// would be a real, unrelated behavior change to already-shipped code.
async function canManageTeamHighlights(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1 AND team_id = $2
      AND role_on_team IN ('coach', 'assistant_coach')
      AND revoked_at IS NULL
    `,
    [userId, teamId]
  );

  return result.rows.length > 0;
}

// Parent/Athlete uploads: real server-side enforcement for Personal Film
// (POST /api/upload-video), replacing a prior Slice 1 draft of this exact
// helper that was built and then deliberately removed rather than shipped
// unenforced -- see that route's own comment. Personal Film has no team
// context to check role_on_team against, so this mirrors the client's
// own refreshUploadSectionVisibility() rule instead: a global role='coach'
// account (teamless-safe -- Personal Film has never required any team
// relationship) OR an active coach/assistant_coach team_members row on
// ANY team. Deliberately does NOT grant Parent/Athlete access in this
// release, even though nothing here technically prevents adding it later
// -- that is a real product decision, not an oversight.
async function canUploadPersonalFilm(userId) {
  if (!userId) return false;

  const userResult = await client.query("SELECT role FROM users WHERE id = $1", [userId]);
  if (userResult.rows[0]?.role === "coach") return true;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1
      AND role_on_team IN ('coach', 'assistant_coach')
      AND revoked_at IS NULL
    LIMIT 1
    `,
    [userId]
  );

  return result.rows.length > 0;
}

// Production bug fix: the uploader must always be able to see their own
// video, regardless of team_id — matching canDeleteVideo's existing
// unconditional uploader check. This was previously only granted in the
// team_id === null branch, so a non-coach who tagged a recording with a
// team they aren't actually a team_members row for (the capture.js team
// picker doesn't verify membership before offering a team) lost
// visibility into their OWN upload — GET /api/videos/:id even 403'd for
// its own uploader. video.team_id === null is the "unassigned" case (see
// videos.js's upload route) — now called Personal Film — visible to the
// uploader (below) or a Platform Admin ONLY, since there's no team to
// scope it to and it is explicitly uploader-private (see canDeleteVideo's
// identical fix and comment for the full incident this closes: any global
// coach previously had blanket access to every uploader's personal
// video). Otherwise, visibility follows team membership for everyone
// except the uploader.
async function canViewVideo(userId, video) {
  if (!userId || !video) return false;

  if (Number(video.uploaded_by) === Number(userId)) return true;

  if (video.team_id === null || video.team_id === undefined) {
    const result = await client.query("SELECT is_platform_admin FROM users WHERE id = $1", [userId]);
    return result.rows[0]?.is_platform_admin === true;
  }

  return canAccessTeam(userId, video.team_id);
}

// Team Highlights, Slice 1 correction: batched sibling of canViewVideo()
// for a route resolving MANY videos in one request (GET
// /api/users/:id/clips) — the per-clip canViewVideo() call the route
// originally used still issues its own query (is_platform_admin, or
// canAccessTeam's team_members lookup) for every clip whose video wasn't
// uploaded by the caller, which is the common case for a team-film
// highlight clip — a real N+1 the route's own "avoids an N+1 query"
// comment only ever covered for the video JOIN, not this. Computes the
// SAME three-branch rule as canViewVideo(), for every video at once, using
// at most two queries total regardless of how many videos are passed (and
// zero extra queries if every video is self-uploaded). Must always agree
// with canViewVideo() for identical inputs — never exposes anything a
// per-video canViewVideo() call wouldn't have. Returns a Map<video.id,
// boolean>.
async function canViewVideosBatch(userId, videos) {
  const decisions = new Map();
  if (!userId) {
    for (const video of videos) decisions.set(video.id, false);
    return decisions;
  }

  const needsPlatformAdminCheck = videos.some(
    (v) => Number(v.uploaded_by) !== Number(userId) && (v.team_id === null || v.team_id === undefined)
  );
  const needsTeamCheck = videos.some(
    (v) => Number(v.uploaded_by) !== Number(userId) && v.team_id !== null && v.team_id !== undefined
  );

  const [isPlatformAdmin, accessibleTeamIds] = await Promise.all([
    needsPlatformAdminCheck
      ? client
          .query("SELECT is_platform_admin FROM users WHERE id = $1", [userId])
          .then((result) => result.rows[0]?.is_platform_admin === true)
      : Promise.resolve(false),
    needsTeamCheck
      ? client
          .query("SELECT team_id FROM team_members WHERE user_id = $1 AND revoked_at IS NULL", [userId])
          .then((result) => new Set(result.rows.map((row) => row.team_id)))
      : Promise.resolve(new Set()),
  ]);

  for (const video of videos) {
    if (Number(video.uploaded_by) === Number(userId)) {
      decisions.set(video.id, true);
    } else if (video.team_id === null || video.team_id === undefined) {
      decisions.set(video.id, isPlatformAdmin);
    } else {
      decisions.set(video.id, accessibleTeamIds.has(video.team_id));
    }
  }
  return decisions;
}

// Team Highlights, Slice 1 correction: canUploadPersonalFilm() (a global
// role='coach'-OR-live-coaching-membership check) was removed here before
// ever being enforced anywhere. The account model it encoded has already
// been superseded: capabilities are meant to derive entirely from live
// team membership/relationship and selected team context, never from a
// permanent global users.role — a person may hold different roles on
// different teams, a no-team user may still keep private personal media,
// and Parent/Athlete uploads in a team context are headed to Team
// Highlights, not this check. Shipping this helper (even inert/unused)
// would have encoded a rejected model into Slice 1's history for no
// benefit, since nothing calls it. The real personal-upload capability
// rule is deferred, to be redesigned alongside the unified-login/Team
// Highlights work instead.

// The role-escalation fix for POST /api/users/:id/teams: a coach may set
// any membership, including a coach-level role_on_team, for anyone. A
// non-coach may only add THEMSELVES, and only with a non-coach role.
async function canManageTeamMembership(userId, targetUserId, roleOnTeam) {
  if (!userId) return false;

  const result = await client.query("SELECT role FROM users WHERE id = $1", [userId]);
  const role = result.rows[0]?.role;

  if (role === "coach") return true;

  return Number(userId) === Number(targetUserId) && roleOnTeam !== "coach";
}

module.exports = {
  canAccessConversation,
  canDeleteVideo,
  canAccessTeam,
  canManageTeam,
  canManageTeamHighlights,
  canUploadPersonalFilm,
  canViewTeamRoster,
  canViewVideo,
  canViewVideosBatch,
  canManageTeamMembership,
  canInitiateDirectMessage,
  isEligibleRecipientPair,
  canAccessDirectMessage,
  directPairKey,
  resolveOrCreateDirectConversation,
  getEligibleRecipients,
};
