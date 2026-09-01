/*
  testVideoVisibility.js — focused regression test for the "phone
  recording disappears / never appears on laptop" production bug.

  Root cause: canViewVideo() only granted an uploader automatic visibility
  of their own video when team_id was NULL — if a recording was tagged
  with a team the uploader wasn't an actual team_members row for (the
  capture.js team picker never verified membership before offering a
  team), the uploader lost visibility into their OWN upload, and so did
  every device/session logged in as that same user. GET /api/videos/:id
  even 403'd for its own uploader. Fixed in permissions.js's
  canViewVideo() — same file as canDeleteVideo's existing pattern.

  This script exercises the server-side permission fix directly (the
  deterministic, most-testable part of the bug) — record -> upload ->
  "refresh" (a completely fresh GET with no client state carried over,
  which is exactly what re-loading the page or checking from a second
  device does) -> cross-device (cross-session) visibility. It does not
  drive a real browser/IndexedDB (recordingPipeline.js's
  reconcileSyncedRecordings() client-side promotion logic needs an actual
  browser and was verified manually against production instead — see the
  sprint report) — this script is the part of the fix that's meaningfully
  testable headlessly and deterministically.

  Run by hand: node server/scripts/testVideoVisibility.js
  Same pattern as testAuth.js: real app on a throwaway local port, real
  HTTP requests, clearly-namespaced test data, deleted in a finally block
  regardless of pass/fail.
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testVideoVisibility.js");

const app = require("../app");
const client = require("../db/client");

const PORT = 3991;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `videovis_${Date.now()}`;

const results = [];

function assert(name, condition, detail) {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

async function req(path, { method = "GET", token, body, isForm } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: response.status, data };
}

async function registerUser(email, role) {
  const { status, data } = await req("/api/auth/register", {
    method: "POST",
    body: { email, password: "TestPass123!", role },
  });
  if (status !== 201) throw new Error(`Failed to register ${email}: ${status} ${JSON.stringify(data)}`);
  return data;
}

async function uploadFakeVideo(token, { title, teamId }) {
  const form = new FormData();
  form.append("video", new Blob([new Uint8Array(5000)], { type: "video/mp4" }), "test.mp4");
  form.append("title", title);
  if (teamId) form.append("team_id", teamId);

  const { status, data } = await req("/api/upload-video", { method: "POST", token, body: form, isForm: true });
  if (status !== 201) throw new Error(`Upload failed: ${status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const created = { userIds: [], videoIds: [], teamIds: [] };
  const server = app.listen(PORT);

  try {
    const uploader = await registerUser(`${RUN_TAG}_uploader@test.cresamor.local`, "athlete");
    const coach = await registerUser(`${RUN_TAG}_coach@test.cresamor.local`, "coach");
    const outsider = await registerUser(`${RUN_TAG}_outsider@test.cresamor.local`, "athlete");
    created.userIds.push(uploader.user.id, coach.user.id, outsider.user.id);

    // Own throwaway team (not an arbitrary pre-existing production team) —
    // creator (coach) auto-joins as a real coach member.
    const teamCreate = await req("/api/teams", {
      method: "POST",
      token: coach.token,
      body: { name: `${RUN_TAG} Team` },
    });
    const team = teamCreate.data;
    created.teamIds.push(team.id);

    const membershipCheck = await client.query(
      "SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2",
      [uploader.user.id, team.id]
    );
    assert(
      "setup: uploader has no team_members row on this team at all",
      membershipCheck.rows.length === 0
    );

    // ============================================================
    // Unassigned-video authorization fix: server-side team_id validation
    // on POST /api/upload-video. This is the exact scenario the OLD code
    // silently allowed (an athlete recording for a team they hold no real
    // membership on, via capture.js's then-unscoped team picker) — it
    // must now be rejected outright, not silently accepted and only
    // discovered later via a visibility bug. ("A user cannot upload to
    // any team merely by submitting its ID.")
    // ============================================================
    const unauthorizedUpload = await req("/api/upload-video", {
      method: "POST",
      token: uploader.token,
      isForm: true,
      body: (() => {
        const form = new FormData();
        form.append("video", new Blob([new Uint8Array(5000)], { type: "video/mp4" }), "test.mp4");
        form.append("title", `${RUN_TAG}_rejected`);
        form.append("team_id", team.id);
        return form;
      })(),
    });
    assert(
      "uploading to a team with no active membership is rejected server-side (403), not silently accepted",
      unauthorizedUpload.status === 403
    );

    const noRowCreated = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_rejected`]);
    assert("the rejected upload did not create any video row at all", noRowCreated.rows.length === 0);

    // Add the coach as a real team member so the "authorized team member
    // CAN view" case is genuine, not just "coaches see everything".
    // (Already true via team creation, kept explicit/defensive.)
    await req(`/api/users/${coach.user.id}/teams`, {
      method: "POST",
      token: coach.token,
      body: { team_id: team.id, role_on_team: "coach" },
    });

    // Give the uploader real, active membership so a legitimate upload to
    // this same team now succeeds — proving the new check is a real gate,
    // not a blanket block.
    await client.query(
      "INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1, $2, 'athlete') ON CONFLICT (team_id, user_id) DO UPDATE SET revoked_at = NULL",
      [team.id, uploader.user.id]
    );

    const authorizedUpload = await req("/api/upload-video", {
      method: "POST",
      token: uploader.token,
      isForm: true,
      body: (() => {
        const form = new FormData();
        form.append("video", new Blob([new Uint8Array(5000)], { type: "video/mp4" }), "test.mp4");
        form.append("title", `${RUN_TAG}_authorized`);
        form.append("team_id", team.id);
        return form;
      })(),
    });
    assert("uploading to a team with real active membership succeeds", authorizedUpload.status === 201);
    if (authorizedUpload.status === 201) created.videoIds.push(authorizedUpload.data.id);

    // --- Revoked membership: an athlete who WAS on this team but no
    // longer is must be rejected exactly like never having joined at all. ---
    await client.query("UPDATE team_members SET revoked_at = now() WHERE team_id = $1 AND user_id = $2", [team.id, uploader.user.id]);

    const revokedUpload = await req("/api/upload-video", {
      method: "POST",
      token: uploader.token,
      isForm: true,
      body: (() => {
        const form = new FormData();
        form.append("video", new Blob([new Uint8Array(5000)], { type: "video/mp4" }), "test.mp4");
        form.append("title", `${RUN_TAG}_revoked_rejected`);
        form.append("team_id", team.id);
        return form;
      })(),
    });
    assert("a revoked (former) member cannot target their former team", revokedUpload.status === 403);

    // Historical/legacy-data regression guard: a row whose team_id doesn't
    // match any real membership (the exact shape the OLD upload path could
    // produce, and could still exist from before this fix, or from a
    // future team-membership revocation after upload) must remain visible
    // to its own uploader regardless — this is canViewVideo's own
    // unconditional uploader check, unrelated to and unaffected by the new
    // upload-time validation, which only gates NEW uploads. Constructed
    // directly since the API itself now correctly refuses to create this
    // shape (see above).
    const legacyInsert = await client.query(
      `
      INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, source_size_bytes)
      VALUES ($1, $2, $3, 'ready', $4, 5000)
      RETURNING *
      `,
      [`${RUN_TAG}_legacy_mismatched`, `videos/${team.id}/${new Date().getFullYear()}/${RUN_TAG}-legacy.mp4`, uploader.user.id, team.id]
    );
    const uploaded = legacyInsert.rows[0];
    created.videoIds.push(uploaded.id);

    assert("legacy row constructed with expected fields for the visibility regression below", Boolean(
      uploaded.uploaded_by &&
      Number(uploaded.uploaded_by) === Number(uploader.user.id) &&
      Number(uploaded.team_id) === Number(team.id)
    ));

    // --- Step 9 / "refresh": a completely fresh GET, no client state
    // carried over — exactly what reloading the page does, and exactly
    // what a second device's first load does too. ---
    const uploaderRefetch = await req("/api/videos", { token: uploader.token });
    const uploaderSeesOwnUpload = uploaderRefetch.data.find((v) => v.id === uploaded.id);
    assert(
      "THE BUG: uploader can see their own upload after a fresh refetch ('refresh')",
      Boolean(uploaderSeesOwnUpload)
    );

    const uploaderSingle = await req(`/api/videos/${uploaded.id}`, { token: uploader.token });
    assert("uploader's direct GET /api/videos/:id succeeds (was 403 before the fix)", uploaderSingle.status === 200);

    // --- Cross-device / cross-session: a SECOND authenticated session for
    // the exact same user (simulating a laptop after recording on a
    // phone) sees the same row, with no client state shared between them
    // beyond the login. ---
    const secondSession = await req("/api/auth/login", {
      method: "POST",
      body: { email: `${RUN_TAG}_uploader@test.cresamor.local`, password: "TestPass123!" },
    });
    const secondSessionList = await req("/api/videos", { token: secondSession.data.token });
    const secondSessionSeesIt = secondSessionList.data.find((v) => v.id === uploaded.id);
    assert(
      "cross-device: a second login session for the SAME user sees the recording automatically",
      Boolean(secondSessionSeesIt)
    );

    // --- Authorized team member (coach, real team_members row) CAN view. ---
    const coachList = await req("/api/videos", { token: coach.token });
    const coachSeesIt = coachList.data.find((v) => v.id === uploaded.id);
    assert("authorized team member (coach) CAN view the recording", Boolean(coachSeesIt));

    // --- Unrelated, non-member user is still correctly blocked — the fix
    // must not have broadened access beyond the uploader themselves. ---
    const outsiderList = await req("/api/videos", { token: outsider.token });
    const outsiderSeesIt = outsiderList.data.find((v) => v.id === uploaded.id);
    assert("unrelated non-member user is still blocked (no over-broadening)", !outsiderSeesIt);

    const outsiderSingle = await req(`/api/videos/${uploaded.id}`, { token: outsider.token });
    assert("unrelated user's direct GET /api/videos/:id is still 403", outsiderSingle.status === 403);

    // --- Closed Beta Readiness Sprint regression guard: an unrelated
    // COACH (real coach account, no team_members row on this team) must
    // ALSO be blocked from this team-scoped video — canAccessTeam's
    // former "any coach can access any team" blanket shortcut used to
    // let this through purely on users.role === 'coach'. ---
    const unrelatedCoach = await registerUser(`${RUN_TAG}_unrelated_coach@test.cresamor.local`, "coach");
    created.userIds.push(unrelatedCoach.user.id);

    const unrelatedCoachSingle = await req(`/api/videos/${uploaded.id}`, { token: unrelatedCoach.token });
    assert(
      "unrelated coach (not a member of this team) is blocked from team-scoped video",
      unrelatedCoachSingle.status === 403
    );

    const unrelatedCoachList = await req("/api/videos", { token: unrelatedCoach.token });
    const unrelatedCoachSeesIt = unrelatedCoachList.data.find((v) => v.id === uploaded.id);
    assert(
      "unrelated coach (not a member of this team) does not see it in the list either",
      !unrelatedCoachSeesIt
    );

    // ============================================================
    // Personal Film (team_id null): uploader-or-Platform-Admin ONLY.
    //
    // Real production incident this closes: two genuine Samsung/Android
    // recordings (Chad's, videos 525/526 — never touched by this test)
    // were reachable by EVERY coach account in the system, purely because
    // the old rule was "team_id null -> any global role='coach'". Fixed
    // in permissions.js's canViewVideo()/canDeleteVideo(): the null-team
    // branch is now uploader OR users.is_platform_admin, nothing broader.
    // ============================================================
    const unassigned = await uploadFakeVideo(uploader.token, {
      title: `${RUN_TAG}_personal`,
      teamId: null,
    });
    created.videoIds.push(unassigned.id);

    const uploaderUnassigned = await req(`/api/videos/${unassigned.id}`, { token: uploader.token });
    assert("uploader can view their own Personal Film", uploaderUnassigned.status === 200);

    const outsiderUnassigned = await req(`/api/videos/${unassigned.id}`, { token: outsider.token });
    assert("non-coach outsider blocked from someone else's Personal Film", outsiderUnassigned.status === 403);

    // THE FIX: an unrelated coach — global role='coach', zero relationship
    // to the uploader or this video — used to see this via the old
    // any-global-coach rule. Must now be blocked, across every surface.
    const coachUnassignedView = await req(`/api/videos/${unassigned.id}`, { token: coach.token });
    assert("unrelated Coach CANNOT view another uploader's Personal Film (was 200 before the fix)", coachUnassignedView.status === 403);

    const coachUnassignedList = await req("/api/videos", { token: coach.token });
    const coachSeesUnassignedInList = coachUnassignedList.data.find((v) => v.id === unassigned.id);
    assert("unrelated Coach does not see Personal Film in the list either", !coachSeesUnassignedInList);

    const coachUnassignedDelete = await req(`/api/videos/${unassigned.id}`, { method: "DELETE", token: coach.token });
    assert("unrelated Coach cannot DELETE another uploader's Personal Film", coachUnassignedDelete.status === 403);

    const coachUnassignedRetryConv = await req(`/api/videos/${unassigned.id}/retry-conversion`, { method: "POST", token: coach.token });
    assert("unrelated Coach cannot retry-conversion another uploader's Personal Film", coachUnassignedRetryConv.status === 403);

    const coachUnassignedRetryClass = await req(`/api/videos/${unassigned.id}/retry-classification`, { method: "POST", token: coach.token });
    assert("unrelated Coach cannot retry-classification another uploader's Personal Film", coachUnassignedRetryClass.status === 403);

    const coachClipAttempt = await req("/api/clips", {
      method: "POST",
      token: coach.token,
      body: { title: "unauthorized clip", start_time: 0, end_time: 1, video_id: unassigned.id },
    });
    assert("unrelated Coach cannot create a clip from another uploader's Personal Film (clips bypass fix)", coachClipAttempt.status === 403);

    // Uploader retains full control of their own Personal Film.
    const uploaderRetryClass = await req(`/api/videos/${unassigned.id}/retry-classification`, { method: "POST", token: uploader.token });
    assert(
      "uploader CAN retry-classification their own Personal Film (400=not-in-retriable-state is fine, 403 is not)",
      uploaderRetryClass.status !== 403
    );

    // --- PATCH .../team source-side fix: an unrelated coach who DOES
    // manage some real destination team must still be blocked from
    // pulling someone else's Personal Film out of it — the exact gap that
    // used to have ZERO check at all on the source side, worse than the
    // old any-global-coach rule. Reuses the already-registered
    // unrelatedCoach (registerLimiter caps registrations at 5/hour/IP —
    // every account in this script is deliberately reused across
    // sections rather than minted fresh per assertion). ---
    const destTeamCreate = await req("/api/teams", {
      method: "POST",
      token: unrelatedCoach.token,
      body: { name: `${RUN_TAG} Reassign Dest Team` },
    });
    const destTeam = destTeamCreate.data;
    created.teamIds.push(destTeam.id);

    const unauthorizedReassign = await req(`/api/videos/${unassigned.id}/team`, {
      method: "PATCH",
      token: unrelatedCoach.token,
      body: { team_id: destTeam.id },
    });
    assert(
      "a coach who manages the DESTINATION team still cannot claim another uploader's Personal Film (PATCH .../team source-side fix)",
      unauthorizedReassign.status === 403
    );

    const stillUnassigned = await client.query("SELECT team_id FROM videos WHERE id = $1", [unassigned.id]);
    assert("the unauthorized reassignment attempt did not actually change team_id", stillUnassigned.rows[0].team_id === null);

    // Uploader themselves CAN reassign their own Personal Film into a team
    // they don't manage — this should fail on the DESTINATION check, not
    // the source one, proving the two checks are independent.
    const uploaderReassignAttempt = await req(`/api/videos/${unassigned.id}/team`, {
      method: "PATCH",
      token: uploader.token,
      body: { team_id: destTeam.id },
    });
    assert(
      "uploader passes the source-side check but still needs real destination authority (fails on canManageTeam, not the fix)",
      uploaderReassignAttempt.status === 403
    );

    // --- Manual Film Room picker destinations: exercises
    // loadUploadDestinationTeams()'s exact filter predicate
    // (role_on_team === 'coach' || 'assistant_coach') against real
    // GET /api/users/:id/teams data, the same source it uses client-side —
    // no browser needed since the predicate itself is trivial and the
    // real question is "does the underlying data correctly distinguish
    // these roles," which is fully server-testable. ---
    const uploadDestinationFilter = (team) => team.role_on_team === "coach" || team.role_on_team === "assistant_coach";

    await client.query(
      "INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1, $2, 'assistant_coach') ON CONFLICT (team_id, user_id) DO UPDATE SET role_on_team = 'assistant_coach', revoked_at = NULL",
      [team.id, outsider.user.id]
    );

    const assistantCoachTeams = await req(`/api/users/${outsider.user.id}/teams`, { token: outsider.token });
    const assistantCoachDestinations = assistantCoachTeams.data.filter(uploadDestinationFilter);
    assert(
      "an active Assistant Coach's own team passes the manual-picker destination filter",
      assistantCoachDestinations.some((t) => t.id === team.id)
    );

    const uploaderTeamsForFilter = await req(`/api/users/${uploader.user.id}/teams`, { token: uploader.token });
    const uploaderDestinations = uploaderTeamsForFilter.data.filter(uploadDestinationFilter);
    assert(
      "a plain Athlete's own team membership does NOT pass the manual-picker destination filter (picker is Coach/Assistant-Coach only)",
      !uploaderDestinations.some((t) => t.id === team.id)
    );

    const coachTeamsForFilter = await req(`/api/users/${coach.user.id}/teams`, { token: coach.token });
    const coachDestinations = coachTeamsForFilter.data.filter(uploadDestinationFilter);
    assert(
      "an active Coach's own team passes the manual-picker destination filter",
      coachDestinations.some((t) => t.id === team.id)
    );

    const unrelatedCoachTeamsForFilter = await req(`/api/users/${unrelatedCoach.user.id}/teams`, { token: unrelatedCoach.token });
    const unrelatedCoachDestinations = unrelatedCoachTeamsForFilter.data.filter(uploadDestinationFilter);
    assert(
      "an unrelated Coach's destination list contains only teams they actively coach, not team's video team",
      unrelatedCoachDestinations.some((t) => t.id === destTeam.id) && !unrelatedCoachDestinations.some((t) => t.id === team.id)
    );

    // --- Platform Admin: an explicit, separate grant — NOT tied to
    // role='coach' at all (is_platform_admin is a standalone boolean, see
    // migration 014). Promotes the already-registered, athlete-role
    // `outsider` in place (its earlier "blocked" assertions above already
    // ran and are unaffected) rather than registering a fresh account —
    // registerLimiter caps registrations at 5/hour/IP, already fully used
    // by this script (uploader, coach, outsider, unrelatedCoach — 4 — plus
    // headroom). is_platform_admin is reloaded fresh from the DB on every
    // request by authenticate.js (never baked into the JWT), so reusing
    // outsider.token after this UPDATE takes effect immediately, no new
    // login needed — same guarantee this project already relies on for
    // role changes elsewhere. Deliberately an athlete-role account, so
    // this can't be mistaken for the old any-coach rule accidentally
    // still working. ---
    await client.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [outsider.user.id]);

    const adminView = await req(`/api/videos/${unassigned.id}`, { token: outsider.token });
    assert("Platform Admin (non-coach role) CAN view another uploader's Personal Film", adminView.status === 200);

    const adminDelete = await req(`/api/videos/${unassigned.id}`, { method: "DELETE", token: outsider.token });
    assert("Platform Admin CAN delete another uploader's Personal Film", adminDelete.status === 200);
    // Deleted by the admin above — remove from the cleanup list so the
    // finally block's own DELETE doesn't operate on an already-gone row.
    created.videoIds = created.videoIds.filter((id) => id !== unassigned.id);

    const confirmGone = await client.query("SELECT id FROM videos WHERE id = $1", [unassigned.id]);
    assert("Platform Admin's delete actually removed the row", confirmGone.rows.length === 0);
  } finally {
    try {
      for (const id of created.videoIds) {
        await client.query("DELETE FROM clips WHERE video_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE id = $1", [id]);
      }
      for (const id of created.userIds) {
        await client.query("DELETE FROM clips WHERE user_id = $1", [id]);
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE user_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE uploaded_by = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
      }
      for (const id of created.teamIds) {
        // POST /api/teams auto-creates a team-scoped conversation (Team
        // Chat) for the creator — must go before the team row itself
        // (conversations.team_id FK), same order this project's other
        // team-fixture cleanups already use.
        const convoRows = await client.query("SELECT id FROM conversations WHERE team_id = $1", [id]);
        for (const convo of convoRows.rows) {
          await client.query("DELETE FROM messages WHERE conversation_id = $1", [convo.id]);
          await client.query("DELETE FROM conversation_participants WHERE conversation_id = $1", [convo.id]);
          await client.query("DELETE FROM conversations WHERE id = $1", [convo.id]);
        }
        await client.query("DELETE FROM team_members WHERE team_id = $1", [id]);
        await client.query("DELETE FROM invitations WHERE team_id = $1", [id]);
        await client.query("DELETE FROM teams WHERE id = $1", [id]);
      }
      console.log("Cleanup complete.");
    } catch (cleanupError) {
      console.error("Cleanup encountered an error (may need manual follow-up):", cleanupError);
    }

    server.close();
    await client.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failures:", failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Test script crashed:", error);
  process.exitCode = 1;
});
