/*
  teams.js — Teams MVP. Team list/detail/roster, create team, invite
  (email/text/manual-link), revoke member.

  Follows this project's established client conventions (see CLAUDE.md):
  no imports, reuses existing globals (apiFetch, currentUser, showMessage,
  switchToScreen from home.js) directly, monkey-patches
  window.activateApp/window.logoutLocalState (chained) for its own
  login/logout lifecycle needs. Names are deliberately prefixed with
  `teams`/`team`/`invite`/`createTeam` throughout — bare names like
  `team`/`teams`/`currentTeam` are already used elsewhere in this
  codebase (capture.js's `cachedTeams`, home.js's `profileTeam`) and this
  project shares one global script scope across all client files.

  The pending-invitation deep-link/accept lifecycle (the part that has to
  run before login even exists) lives in invitations.js, not here — see
  that file for the "?invite=" URL handling, forgot/reset-password, and
  post-auth accept flow.
*/

const teamsScreenState = {
  myTeams: [],
  currentTeamId: null,
  currentTeamDetail: null,
  currentTeamRoster: [],
  currentTeamInvitations: [],
};

// ---------- DOM refs ----------

const teamsListView = document.getElementById("teams-list-view");
const teamsEmptyState = document.getElementById("teams-empty-state");
const teamsListContainer = document.getElementById("teams-list");
const createTeamBtn = document.getElementById("create-team-btn");

const teamDetailView = document.getElementById("team-detail-view");
const teamDetailBackBtn = document.getElementById("team-detail-back-btn");
const teamDetailNameEl = document.getElementById("team-detail-name");
const teamDetailMetaEl = document.getElementById("team-detail-meta");
const teamDetailActions = document.getElementById("team-detail-actions");
const inviteMemberBtn = document.getElementById("invite-member-btn");
const teamRosterList = document.getElementById("team-roster-list");

const teamInvitationsSection = document.getElementById("team-invitations-section");
const teamInvitationsEmpty = document.getElementById("team-invitations-empty");
const teamInvitationsList = document.getElementById("team-invitations-list");

const createTeamModal = document.getElementById("create-team-modal");
const createTeamCloseBtn = document.getElementById("create-team-close-btn");
const createTeamNameInput = document.getElementById("create-team-name-input");
const createTeamSportInput = document.getElementById("create-team-sport-input");
const createTeamSubmitBtn = document.getElementById("create-team-submit-btn");

const inviteModal = document.getElementById("invite-modal");
const inviteCloseBtn = document.getElementById("invite-close-btn");
const inviteStepForm = document.getElementById("invite-step-form");
const inviteTeamNameLabel = document.getElementById("invite-team-name-label");
const inviteRoleSelect = document.getElementById("invite-role-select");
const inviteDestinationTypeSelect = document.getElementById("invite-destination-type-select");
const inviteDestinationInput = document.getElementById("invite-destination-input");
const inviteFormError = document.getElementById("invite-form-error");
const inviteSendBtn = document.getElementById("invite-send-btn");
const inviteStepConfirmation = document.getElementById("invite-step-confirmation");
const inviteConfirmationMessage = document.getElementById("invite-confirmation-message");
const inviteLinkInput = document.getElementById("invite-link-input");
const inviteCopyLinkBtn = document.getElementById("invite-copy-link-btn");
const inviteShareSmsBtn = document.getElementById("invite-share-sms-btn");
const inviteDoneBtn = document.getElementById("invite-done-btn");

const ROLE_LABELS = { athlete: "Athlete", parent: "Parent", assistant_coach: "Assistant Coach", coach: "Coach" };

// ---------- team list ----------

async function loadTeamsList() {
  if (!currentUser) return;

  try {
    teamsScreenState.myTeams = await apiFetch(`/api/users/${currentUser.id}/teams`);
    renderTeamsList();
  } catch (error) {
    console.error("Failed to load teams:", error);
  }
}

function renderTeamsList() {
  teamsListContainer.innerHTML = "";
  teamsEmptyState.classList.toggle("hidden", teamsScreenState.myTeams.length > 0);

  teamsScreenState.myTeams.forEach((team) => {
    const item = document.createElement("li");
    item.className = "team-list-item";

    const info = document.createElement("div");
    info.className = "team-list-item-info";
    info.innerHTML = `<strong>${team.name}</strong><span class="team-list-item-meta">${team.member_count} member${team.member_count === "1" ? "" : "s"} · ${ROLE_LABELS[team.role_on_team] || team.role_on_team || "Member"}</span>`;

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = team.role_on_team === "coach" ? "Manage" : "View";
    openBtn.addEventListener("click", () => openTeamDetail(team.id));

    item.appendChild(info);
    item.appendChild(openBtn);
    teamsListContainer.appendChild(item);
  });
}

// ---------- team detail / roster ----------

async function openTeamDetail(teamId) {
  teamsScreenState.currentTeamId = teamId;

  try {
    const [detail, roster] = await Promise.all([
      apiFetch(`/api/teams/${teamId}`),
      apiFetch(`/api/teams/${teamId}/members`),
    ]);
    teamsScreenState.currentTeamDetail = detail;
    teamsScreenState.currentTeamRoster = roster;
    teamsScreenState.currentTeamInvitations = [];

    // The invitations list endpoint is canManageTeam-gated (coach-level
    // membership on THIS team) — only fetch it for a caller who can
    // actually manage this team, so a plain roster viewer doesn't trigger
    // an expected-but-noisy 403.
    if (currentUserCanManageCurrentTeam()) {
      try {
        teamsScreenState.currentTeamInvitations = await apiFetch(`/api/teams/${teamId}/invitations`);
      } catch (error) {
        console.error("Failed to load team invitations:", error);
      }
    }

    renderTeamDetail();

    teamsListView.classList.add("hidden");
    teamDetailView.classList.remove("hidden");
  } catch (error) {
    console.error("Failed to load team detail:", error);
    showMessage("Could not open this team. It may no longer exist, or you may not have access.");
  }
}

function closeTeamDetail() {
  teamsScreenState.currentTeamId = null;
  teamDetailView.classList.add("hidden");
  teamsListView.classList.remove("hidden");
  loadTeamsList();
}

function currentUserCanManageCurrentTeam() {
  const myMembership = teamsScreenState.myTeams.find((t) => t.id === teamsScreenState.currentTeamId);
  return Boolean(myMembership && myMembership.role_on_team === "coach");
}

function renderTeamDetail() {
  const team = teamsScreenState.currentTeamDetail;
  if (!team) return;

  teamDetailNameEl.textContent = team.name;
  teamDetailMetaEl.textContent = [team.sport, team.school_name, `${team.member_count} member${team.member_count === "1" ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");

  const canManage = currentUserCanManageCurrentTeam();
  teamDetailActions.classList.toggle("hidden", !canManage);

  teamRosterList.innerHTML = "";
  teamsScreenState.currentTeamRoster.forEach((member) => {
    const item = document.createElement("li");
    item.className = "team-roster-item";

    const info = document.createElement("div");
    info.className = "team-roster-item-info";
    info.innerHTML = `<strong>${member.display_name || member.email}</strong><span class="team-roster-item-meta">${ROLE_LABELS[member.role_on_team] || member.role_on_team}</span>`;

    item.appendChild(info);

    if (canManage && member.id !== currentUser.id) {
      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "team-roster-revoke-btn";
      revokeBtn.textContent = "Remove";
      revokeBtn.addEventListener("click", () => revokeMember(member.id, member.display_name || member.email));
      item.appendChild(revokeBtn);
    }

    teamRosterList.appendChild(item);
  });

  renderTeamInvitations();
}

const INVITATION_STATUS_LABELS = { pending: "Pending", accepted: "Accepted", expired: "Expired", revoked: "Revoked" };

// The server never flips status from 'pending' to 'expired' on a timer —
// expiry is only checked at preview/accept time (see invitations.js's
// service layer) — so "expired" has to be derived client-side by
// comparing expires_at to now whenever status is still 'pending'.
function effectiveInvitationStatus(invitation) {
  if (invitation.status === "pending" && new Date(invitation.expires_at).getTime() < Date.now()) {
    return "expired";
  }
  return invitation.status;
}

function renderTeamInvitations() {
  if (!teamInvitationsSection) return;

  const canManage = currentUserCanManageCurrentTeam();
  teamInvitationsSection.classList.toggle("hidden", !canManage);
  if (!canManage) return;

  const invitations = teamsScreenState.currentTeamInvitations;
  teamInvitationsEmpty.classList.toggle("hidden", invitations.length > 0);

  teamInvitationsList.innerHTML = "";
  invitations.forEach((invitation) => {
    const status = effectiveInvitationStatus(invitation);
    const item = document.createElement("li");
    item.className = "team-invitation-item";

    const info = document.createElement("div");
    info.className = "team-invitation-item-info";
    info.innerHTML = `
      <strong>${invitation.destination}</strong>
      <span class="team-invitation-item-meta">${ROLE_LABELS[invitation.role_on_team] || invitation.role_on_team} · ${invitation.destination_type === "phone" ? "Text" : "Email"}</span>
      <span class="invitation-status-badge invitation-status-${status}">${INVITATION_STATUS_LABELS[status] || status}</span>
    `;

    item.appendChild(info);
    teamInvitationsList.appendChild(item);
  });
}

async function revokeMember(userId, label) {
  if (!confirm(`Remove ${label} from this team? Their Cresamor account is not affected — they can be re-invited any time.`)) {
    return;
  }

  try {
    await apiFetch(`/api/teams/${teamsScreenState.currentTeamId}/members/${userId}`, { method: "DELETE" });
    const roster = await apiFetch(`/api/teams/${teamsScreenState.currentTeamId}/members`);
    teamsScreenState.currentTeamRoster = roster;
    renderTeamDetail();
  } catch (error) {
    console.error("Failed to remove member:", error);
    showMessage(error.message || "Could not remove this member. Please try again.");
  }
}

// ---------- create team ----------

function openCreateTeamModal() {
  createTeamNameInput.value = "";
  createTeamSportInput.value = "";
  createTeamModal.classList.remove("hidden");
}

function closeCreateTeamModal() {
  createTeamModal.classList.add("hidden");
}

async function submitCreateTeam() {
  const name = createTeamNameInput.value.trim();
  if (!name) {
    showMessage("Please enter a team name.");
    return;
  }

  try {
    await apiFetch("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, sport: createTeamSportInput.value.trim() || undefined }),
    });
    closeCreateTeamModal();
    await loadTeamsList();
    showMessage(`${name} has been created.`);
  } catch (error) {
    console.error("Failed to create team:", error);
    showMessage(error.message || "Could not create this team. Please try again.");
  }
}

// ---------- invite member ----------

function openInviteModal() {
  inviteTeamNameLabel.textContent = teamsScreenState.currentTeamDetail
    ? `Inviting to ${teamsScreenState.currentTeamDetail.name}`
    : "";
  inviteDestinationInput.value = "";
  inviteFormError.classList.add("hidden");
  inviteStepForm.classList.remove("hidden");
  inviteStepConfirmation.classList.add("hidden");
  updateInviteDestinationPlaceholder();
  inviteModal.classList.remove("hidden");
}

function closeInviteModal() {
  inviteModal.classList.add("hidden");
}

function updateInviteDestinationPlaceholder() {
  inviteDestinationInput.placeholder =
    inviteDestinationTypeSelect.value === "phone" ? "Phone number" : "Email address";
  inviteDestinationInput.type = inviteDestinationTypeSelect.value === "phone" ? "tel" : "email";
}

// "sms:NUMBER?&body=TEXT" — the "?&" form is a well-known cross-platform
// trick that both iOS (which normally wants "&body=") and Android (which
// normally wants "?body=") accept. No SMS library — this just opens the
// device's own composer with the message prefilled, per the spec.
function buildSmsHref(destination, message) {
  return `sms:${encodeURIComponent(destination)}?&body=${encodeURIComponent(message)}`;
}

async function submitInvite() {
  const destination = inviteDestinationInput.value.trim();
  const destinationType = inviteDestinationTypeSelect.value;
  const roleOnTeam = inviteRoleSelect.value;

  if (!destination) {
    inviteFormError.textContent =
      destinationType === "phone" ? "Please enter a phone number." : "Please enter an email address.";
    inviteFormError.classList.remove("hidden");
    return;
  }

  inviteSendBtn.disabled = true;
  inviteSendBtn.textContent = "Sending...";

  try {
    const invitation = await apiFetch(`/api/teams/${teamsScreenState.currentTeamId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationType, destination, roleOnTeam }),
    });

    inviteStepForm.classList.add("hidden");
    inviteStepConfirmation.classList.remove("hidden");
    inviteLinkInput.value = invitation.inviteUrl;

    const teamName = teamsScreenState.currentTeamDetail?.name || "the team";
    const roleLabel = ROLE_LABELS[roleOnTeam] || roleOnTeam;

    if (destinationType === "email" && invitation.emailSent) {
      inviteConfirmationMessage.textContent = `Invitation emailed to ${invitation.destination}. You can also copy the link below.`;
      inviteShareSmsBtn.classList.add("hidden");
    } else if (destinationType === "email") {
      inviteConfirmationMessage.textContent = `Invitation created — email delivery isn't configured yet, so copy the link below and send it to ${invitation.destination} yourself.`;
      inviteShareSmsBtn.classList.add("hidden");
    } else {
      inviteConfirmationMessage.textContent = `Invitation created for ${invitation.destination}. Send it via text or copy the link below.`;
      inviteShareSmsBtn.classList.remove("hidden");
      inviteShareSmsBtn.onclick = () => {
        window.location.href = buildSmsHref(
          invitation.destination,
          `You've been invited to join ${teamName} as ${roleLabel} on Cresamor Film Room: ${invitation.inviteUrl}`
        );
      };
    }
  } catch (error) {
    console.error("Failed to create invitation:", error);
    inviteFormError.textContent = error.message || "Could not send this invitation. Please try again.";
    inviteFormError.classList.remove("hidden");
  } finally {
    inviteSendBtn.disabled = false;
    inviteSendBtn.textContent = "Send Invite";
  }
}

async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(inviteLinkInput.value);
    showMessage("Invite link copied.");
  } catch {
    inviteLinkInput.select();
    showMessage("Could not copy automatically — the link is selected, copy it manually.");
  }
}

// ---------- wiring ----------

createTeamBtn.addEventListener("click", openCreateTeamModal);
createTeamCloseBtn.addEventListener("click", closeCreateTeamModal);
createTeamSubmitBtn.addEventListener("click", submitCreateTeam);

teamDetailBackBtn.addEventListener("click", closeTeamDetail);
inviteMemberBtn.addEventListener("click", openInviteModal);

inviteCloseBtn.addEventListener("click", closeInviteModal);
inviteDoneBtn.addEventListener("click", async () => {
  closeInviteModal();
  if (teamsScreenState.currentTeamId) {
    const [roster, invitations] = await Promise.all([
      apiFetch(`/api/teams/${teamsScreenState.currentTeamId}/members`),
      currentUserCanManageCurrentTeam()
        ? apiFetch(`/api/teams/${teamsScreenState.currentTeamId}/invitations`)
        : Promise.resolve(teamsScreenState.currentTeamInvitations),
    ]);
    teamsScreenState.currentTeamRoster = roster;
    teamsScreenState.currentTeamInvitations = invitations;
    renderTeamDetail();
  }
});
inviteSendBtn.addEventListener("click", submitInvite);
inviteCopyLinkBtn.addEventListener("click", copyInviteLink);
inviteDestinationTypeSelect.addEventListener("change", updateInviteDestinationPlaceholder);

// ---------- login lifecycle ----------

const __originalActivateAppForTeams = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForTeams(user);
  teamDetailView.classList.add("hidden");
  teamsListView.classList.remove("hidden");
  loadTeamsList();
};

const __originalLogoutLocalStateForTeams = window.logoutLocalState;
window.logoutLocalState = function () {
  teamsScreenState.myTeams = [];
  teamsScreenState.currentTeamId = null;
  teamsScreenState.currentTeamDetail = null;
  teamsScreenState.currentTeamRoster = [];
  __originalLogoutLocalStateForTeams();
};

// Exposed so invitations.js can refresh the Teams screen after a
// successful accept without this file needing to know anything about
// invitations itself.
window.refreshTeamsAfterInviteAccept = function () {
  loadTeamsList();
};

// Covers the case where a session was already restored by app.js's own
// restoreSession() call before this script finished loading — same
// established precedent as home.js's identical fallback (restoreSession()
// runs at app.js's own bottom, before teams.js has loaded and wrapped
// activateApp, so a returning logged-in user needs this explicit check
// too, not just the wrap above).
if (currentUser) {
  loadTeamsList();
}
