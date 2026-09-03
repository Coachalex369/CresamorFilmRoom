/*
  teamHighlightsScreen.js — Team Highlights UI release. Drives the
  "Team Highlights" tab (formerly "Highlights", which was personal saved
  clips/snapshots -- that content moved to Home's Featured Reel, which
  already rendered the same GET /api/users/:id/clips data, so nothing
  new was built for it; My Snapshots relocated as the same unwired
  placeholder it already was, see index.html). This screen is
  exclusively the team-scoped feed from server/routes/teamHighlights.js
  (GET/POST/DELETE /api/teams/:teamId/highlights).

  Loads last (after schedule.js), same shared-global-scope convention as
  every other client file -- see CLAUDE.md. Depends on globals from
  app.js (apiFetch, currentUser, authToken via apiFetch, selectVideo,
  unavailableReason, resolveVideoSrc) and home.js (switchToScreen).
  Reuses selectVideo() for playback instead of a second player, and
  unavailableReason()/resolveVideoSrc() instead of re-deriving playback
  status/URL logic that already exists.
*/

const teamHighlightsHeader = document.querySelector("#team-highlights-header");
const teamHighlightsPublishBtn = document.querySelector("#team-highlights-publish-btn");
const teamHighlightsTeamLabel = document.querySelector("#team-highlights-team-label");
const teamHighlightsTeamSelectLabel = document.querySelector("#team-highlights-team-select-label");
const teamHighlightsTeamSelect = document.querySelector("#team-highlights-team-select");
const teamHighlightsTeamEmpty = document.querySelector("#team-highlights-team-empty");
const teamHighlightsFeedEl = document.querySelector("#team-highlights-feed");
const teamHighlightsFeedEmpty = document.querySelector("#team-highlights-feed-empty");
const teamHighlightsFeedError = document.querySelector("#team-highlights-feed-error");

const teamHighlightsPublishModal = document.querySelector("#team-highlights-publish-modal");
const teamHighlightsPublishCloseBtn = document.querySelector("#team-highlights-publish-close-btn");
const teamHighlightsPublishPickerList = document.querySelector("#team-highlights-publish-picker-list");
const teamHighlightsPublishPickerEmpty = document.querySelector("#team-highlights-publish-picker-empty");
const teamHighlightsPublishError = document.querySelector("#team-highlights-publish-error");

const TEAM_HIGHLIGHTS_TEAM_STORAGE_KEY = "cresamor_team_highlights_team";

const teamHighlightsState = {
  myTeams: [], // [{id, name, sport, role_on_team, ...}] from GET /api/users/:id/teams
  selectedTeamId: null,
  feed: [],
};

let teamHighlightsScreenLoaded = false;

/* ---------- team selection (single-team only -- the feed endpoint is
   always scoped to exactly one team, unlike Schedule's "All Teams") ---------- */

function teamHighlightsTeamDisplayLabel(team) {
  return [team.name, team.sport, team.school_name].filter(Boolean).join(" — ");
}

function getStoredTeamHighlightsTeamPreference() {
  return localStorage.getItem(TEAM_HIGHLIGHTS_TEAM_STORAGE_KEY);
}

function setSelectedTeamHighlightsTeam(value) {
  teamHighlightsState.selectedTeamId = value;
  if (value !== null && value !== undefined) {
    localStorage.setItem(TEAM_HIGHLIGHTS_TEAM_STORAGE_KEY, String(value));
  } else {
    localStorage.removeItem(TEAM_HIGHLIGHTS_TEAM_STORAGE_KEY);
  }
}

// Convenience list only -- POST/DELETE are independently re-authorized
// server-side via canManageTeamHighlights() regardless of what this
// offers, same "UX narrowing, not enforcement" principle as
// loadUploadDestinationTeams() (app.js). Includes assistant_coach,
// matching canManageTeamHighlights()'s actual rule -- unlike
// loadManageableTeams()'s coach-only list, which would incorrectly hide
// this from a genuine Assistant Coach.
function currentTeamHighlightsRoleOnTeam() {
  const team = teamHighlightsState.myTeams.find((t) => Number(t.id) === Number(teamHighlightsState.selectedTeamId));
  return team ? team.role_on_team : null;
}

function canManageSelectedTeamHighlightsClientSide() {
  const role = currentTeamHighlightsRoleOnTeam();
  return role === "coach" || role === "assistant_coach";
}

async function loadTeamHighlightsTeams() {
  if (!currentUser) return;

  try {
    teamHighlightsState.myTeams = (await apiFetch(`/api/users/${currentUser.id}/teams`)) || [];
  } catch (error) {
    console.error("Failed to load teams for Team Highlights:", error);
    teamHighlightsState.myTeams = [];
  }

  const teams = teamHighlightsState.myTeams;
  const stored = getStoredTeamHighlightsTeamPreference();

  if (!teams.length) {
    setSelectedTeamHighlightsTeam(null);
  } else if (teams.length === 1) {
    setSelectedTeamHighlightsTeam(teams[0].id);
  } else {
    const storedIsValid = stored && teams.some((t) => Number(t.id) === Number(stored));
    setSelectedTeamHighlightsTeam(storedIsValid ? Number(stored) : teams[0].id);
  }

  renderTeamHighlightsTeamContext();
}

function renderTeamHighlightsTeamContext() {
  const teams = teamHighlightsState.myTeams;

  teamHighlightsTeamLabel.classList.add("hidden");
  teamHighlightsTeamSelectLabel.classList.add("hidden");
  teamHighlightsTeamSelect.classList.add("hidden");
  teamHighlightsTeamEmpty.classList.add("hidden");

  if (!teams.length) {
    teamHighlightsTeamEmpty.classList.remove("hidden");
    teamHighlightsPublishBtn.classList.add("hidden");
    return;
  }

  if (teams.length === 1) {
    teamHighlightsTeamLabel.textContent = teamHighlightsTeamDisplayLabel(teams[0]);
    teamHighlightsTeamLabel.classList.remove("hidden");
  } else {
    teamHighlightsTeamSelectLabel.classList.remove("hidden");
    teamHighlightsTeamSelect.classList.remove("hidden");
    teamHighlightsTeamSelect.innerHTML = "";

    teams.forEach((team) => {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = teamHighlightsTeamDisplayLabel(team);
      option.selected = Number(team.id) === Number(teamHighlightsState.selectedTeamId);
      teamHighlightsTeamSelect.appendChild(option);
    });
  }

  teamHighlightsPublishBtn.classList.toggle("hidden", !canManageSelectedTeamHighlightsClientSide());
}

if (teamHighlightsTeamSelect) {
  teamHighlightsTeamSelect.addEventListener("change", async () => {
    setSelectedTeamHighlightsTeam(Number(teamHighlightsTeamSelect.value));
    renderTeamHighlightsTeamContext();
    await loadTeamHighlightsFeed();
  });
}

/* ---------- feed ---------- */

// Short badge text -- same wording/values as app.js's renderVideoList()
// uses for the Film list, kept as its own small copy here since those
// are declared inside that function (not exported globals in this
// no-module-system codebase). unavailableReason() itself IS reused
// directly below for the full-sentence status line, not duplicated.
const TEAM_HIGHLIGHTS_SHORT_STATUS = {
  uploading: "uploading",
  preparing_playback: "preparing",
  processing_paused: "processing",
  failed: "failed",
};

function teamHighlightsShortStatus(video) {
  if (video.available === false) return "unavailable";
  return TEAM_HIGHLIGHTS_SHORT_STATUS[video.playback_state] || null;
}

async function loadTeamHighlightsFeed() {
  teamHighlightsFeedError.classList.add("hidden");

  if (!teamHighlightsState.selectedTeamId) {
    teamHighlightsState.feed = [];
    renderTeamHighlightsFeed();
    return;
  }

  try {
    teamHighlightsState.feed = (await apiFetch(`/api/teams/${teamHighlightsState.selectedTeamId}/highlights`)) || [];
  } catch (error) {
    console.error("Failed to load Team Highlights feed:", error);
    teamHighlightsState.feed = [];
    teamHighlightsFeedError.classList.remove("hidden");
  }

  renderTeamHighlightsFeed();
}

function canRemoveTeamHighlightEntry(entry) {
  if (!currentUser) return false;
  return Number(entry.video.uploaded_by) === Number(currentUser.id) || canManageSelectedTeamHighlightsClientSide();
}

function renderTeamHighlightsFeed() {
  teamHighlightsFeedEl.innerHTML = "";
  const entries = teamHighlightsState.feed;

  teamHighlightsFeedEmpty.classList.toggle("hidden", entries.length > 0 || !teamHighlightsState.selectedTeamId);

  entries.forEach((entry) => {
    const video = entry.video;
    const li = document.createElement("li");
    li.className = "team-highlight-card";

    const thumb = document.createElement("div");
    thumb.className = "team-highlight-thumb";
    if (video.thumbnail_url) {
      thumb.style.backgroundImage = `url("${resolveVideoSrc(video.thumbnail_url)}")`;
    }
    li.appendChild(thumb);

    const info = document.createElement("div");
    info.className = "team-highlight-info";

    const titleLine = document.createElement("strong");
    titleLine.textContent = video.title;

    const shortStatus = teamHighlightsShortStatus(video);
    if (shortStatus) {
      const badge = document.createElement("span");
      badge.className = "video-item-badge";
      if (video.playback_state === "preparing_playback") badge.classList.add("badge-syncing");
      badge.textContent = shortStatus;
      titleLine.appendChild(badge);
    }

    info.appendChild(titleLine);

    // Processing videos display honestly: reuses app.js's exact status
    // copy (unavailableReason) instead of a second "is this playable"
    // implementation -- never claims playable when it isn't.
    const reason = unavailableReason(video);
    if (reason) {
      const statusText = document.createElement("p");
      statusText.textContent = reason;
      info.appendChild(statusText);
    }

    li.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "team-highlight-actions";

    if (!reason) {
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.textContent = "Play";
      playBtn.addEventListener("click", () => {
        switchToScreen("film-screen");
        selectVideo(video);
      });
      actions.appendChild(playBtn);
    }

    if (canRemoveTeamHighlightEntry(entry)) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => removeTeamHighlightEntry(entry));
      actions.appendChild(removeBtn);
    }

    li.appendChild(actions);
    teamHighlightsFeedEl.appendChild(li);
  });
}

// Removing a post never deletes the source video, clips, or the R2
// object directly (server-side, at most marks the source for the
// existing sweeper to reconsider) -- same "does not delete the file"
// caveat as deleteVideo()'s confirm copy in app.js.
async function removeTeamHighlightEntry(entry) {
  const confirmed = confirm(
    `Remove "${entry.video.title}" from Team Highlights?\n\nThis removes it from this team's Team Highlights feed. The original Team Film (and any clips made from it) are unaffected.`
  );
  if (!confirmed) return;

  try {
    await apiFetch(`/api/teams/${teamHighlightsState.selectedTeamId}/highlights/${entry.id}`, { method: "DELETE" });
    await loadTeamHighlightsFeed();
  } catch (error) {
    console.error("Failed to remove Team Highlight:", error);
    teamHighlightsFeedError.textContent = error.message || "Could not remove this Team Highlight.";
    teamHighlightsFeedError.classList.remove("hidden");
  }
}

/* ---------- publish picker ---------- */

function closeTeamHighlightsPublishModal() {
  teamHighlightsPublishModal.classList.add("hidden");
  teamHighlightsPublishPickerList.innerHTML = "";
  teamHighlightsPublishError.classList.add("hidden");
}

async function openTeamHighlightsPublishModal() {
  if (!teamHighlightsState.selectedTeamId) return;

  teamHighlightsPublishError.classList.add("hidden");
  teamHighlightsPublishPickerEmpty.classList.add("hidden");
  teamHighlightsPublishPickerList.innerHTML = "<li>Loading…</li>";
  teamHighlightsPublishModal.classList.remove("hidden");

  let eligible = [];
  try {
    const videos = (await apiFetch("/api/videos")) || [];
    const alreadyPublished = new Set(teamHighlightsState.feed.map((entry) => Number(entry.video_id)));

    // GET /api/videos already excludes film_removed_at and
    // upload_destination='team_highlights' rows server-side, and is
    // already scoped to what this user can view (canViewVideo) -- this
    // is a UX narrowing on top of that, not the eligibility check
    // itself, which POST /api/teams/:teamId/highlights re-verifies
    // independently regardless of what this list offers.
    eligible = videos.filter(
      (video) =>
        Number(video.team_id) === Number(teamHighlightsState.selectedTeamId) &&
        video.upload_destination === "team_film" &&
        !alreadyPublished.has(Number(video.id))
    );
  } catch (error) {
    console.error("Failed to load eligible Team Film:", error);
    teamHighlightsPublishPickerList.innerHTML = "";
    teamHighlightsPublishError.textContent = "Could not load Team Film for this team.";
    teamHighlightsPublishError.classList.remove("hidden");
    return;
  }

  teamHighlightsPublishPickerList.innerHTML = "";

  if (!eligible.length) {
    teamHighlightsPublishPickerEmpty.classList.remove("hidden");
    return;
  }

  eligible.forEach((video) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = video.title;
    button.addEventListener("click", () => publishTeamHighlight(video.id));
    li.appendChild(button);
    teamHighlightsPublishPickerList.appendChild(li);
  });
}

async function publishTeamHighlight(videoId) {
  teamHighlightsPublishError.classList.add("hidden");

  try {
    await apiFetch(`/api/teams/${teamHighlightsState.selectedTeamId}/highlights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
    closeTeamHighlightsPublishModal();
    await loadTeamHighlightsFeed();
  } catch (error) {
    console.error("Failed to publish Team Highlight:", error);
    teamHighlightsPublishError.textContent = error.message || "Could not publish this video.";
    teamHighlightsPublishError.classList.remove("hidden");
  }
}

if (teamHighlightsPublishBtn) {
  teamHighlightsPublishBtn.addEventListener("click", openTeamHighlightsPublishModal);
}

if (teamHighlightsPublishCloseBtn) {
  teamHighlightsPublishCloseBtn.addEventListener("click", closeTeamHighlightsPublishModal);
}

/* ---------- entry point / lifecycle ---------- */

async function initTeamHighlightsScreen() {
  if (!currentUser) return;

  // Re-validate on every screen entry, not just the first -- team
  // membership can change (revocation) while the app stays open, same
  // reasoning as Schedule's initScheduleScreen().
  await loadTeamHighlightsTeams();
  await loadTeamHighlightsFeed();
  teamHighlightsScreenLoaded = true;
}

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.screen === "highlights-screen") {
      initTeamHighlightsScreen();
    }
  });
});

const __originalActivateAppForTeamHighlights = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForTeamHighlights(user);
  teamHighlightsScreenLoaded = false;
  teamHighlightsState.myTeams = [];
  teamHighlightsState.selectedTeamId = null;
  teamHighlightsState.feed = [];

  // Tab-active state (.tab-btn/.app-screen "active" classes) is never
  // reset on login/logout anywhere in this app -- only real tab clicks
  // toggle it. On a shared device, logging out while Team Highlights is
  // the visually-active tab and a different user logging back in would
  // otherwise leave this screen showing empty/stale data (and a
  // publish button computed for nobody) until they happened to click
  // away and back. Proactively re-initializing here, same idempotent
  // path the tab-click listener uses, closes that gap for this screen
  // specifically -- found via manual browser testing switching between
  // coach/athlete fixture accounts.
  if (document.querySelector("#highlights-screen")?.classList.contains("active")) {
    initTeamHighlightsScreen();
  }
};

const __originalLogoutLocalStateForTeamHighlights = window.logoutLocalState;
window.logoutLocalState = function () {
  teamHighlightsScreenLoaded = false;
  teamHighlightsState.myTeams = [];
  teamHighlightsState.selectedTeamId = null;
  teamHighlightsState.feed = [];
  teamHighlightsFeedEl.innerHTML = "";
  closeTeamHighlightsPublishModal();
  __originalLogoutLocalStateForTeamHighlights();
};
