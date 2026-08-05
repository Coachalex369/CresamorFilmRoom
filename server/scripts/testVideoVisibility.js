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
  const created = { userIds: [], videoIds: [] };
  const server = app.listen(PORT);

  try {
    // The exact bug scenario: an athlete who records for a team they are
    // NOT an actual team_members row for (the client-side team picker
    // lists every team via GET /api/teams with no membership filter, so
    // this is a completely normal, easy-to-hit path, not a contrived edge
    // case).
    const uploader = await registerUser(`${RUN_TAG}_uploader@test.cresamor.local`, "athlete");
    const coach = await registerUser(`${RUN_TAG}_coach@test.cresamor.local`, "coach");
    const outsider = await registerUser(`${RUN_TAG}_outsider@test.cresamor.local`, "athlete");
    created.userIds.push(uploader.user.id, coach.user.id, outsider.user.id);

    const teamsResult = await req("/api/teams", { token: uploader.token });
    const team = teamsResult.data[0];
    if (!team) throw new Error("No team available to test with — seed data missing");

    const membershipCheck = await client.query(
      "SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2",
      [uploader.user.id, team.id]
    );
    assert(
      "setup: uploader is genuinely NOT a team_members row (this is the bug precondition)",
      membershipCheck.rows.length === 0
    );

    // Add the coach as a real team member so the "authorized team member
    // CAN view" case is genuine, not just "coaches see everything".
    await req(`/api/users/${coach.user.id}/teams`, {
      method: "POST",
      token: coach.token,
      body: { team_id: team.id, role_on_team: "coach" },
    });

    // --- Step 1-6: capture -> upload -> server row exists with expected fields ---
    const uploaded = await uploadFakeVideo(uploader.token, {
      title: `${RUN_TAG}_recording`,
      teamId: team.id,
    });
    created.videoIds.push(uploaded.id);

    assert("upload creates a row with storage_key, uploaded_by, team_id, processing_status", Boolean(
      uploaded.storage_key &&
      Number(uploaded.uploaded_by) === Number(uploader.user.id) &&
      Number(uploaded.team_id) === Number(team.id) &&
      uploaded.processing_status
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

    // --- Unassigned (team_id null) recordings: uploader-or-coach only,
    // unchanged behavior — regression guard for the other canViewVideo
    // branch this fix sits next to. ---
    const unassigned = await uploadFakeVideo(uploader.token, {
      title: `${RUN_TAG}_unassigned`,
      teamId: null,
    });
    created.videoIds.push(unassigned.id);

    const uploaderUnassigned = await req(`/api/videos/${unassigned.id}`, { token: uploader.token });
    assert("uploader can view their own unassigned (team_id null) recording", uploaderUnassigned.status === 200);

    const outsiderUnassigned = await req(`/api/videos/${unassigned.id}`, { token: outsider.token });
    assert("non-coach outsider still blocked from an unassigned recording", outsiderUnassigned.status === 403);

    const coachUnassigned = await req(`/api/videos/${unassigned.id}`, { token: coach.token });
    assert("coach can still view any unassigned recording", coachUnassigned.status === 200);
  } finally {
    try {
      for (const id of created.videoIds) {
        await client.query("DELETE FROM clips WHERE video_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE id = $1", [id]);
      }
      for (const id of created.userIds) {
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE user_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE uploaded_by = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
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
