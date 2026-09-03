/*
  invitations.js — Teams MVP. Owns the entire pending-invitation deep-link
  lifecycle and the forgot/reset-password flow, kept separate from
  teams.js because this part has to work BEFORE login exists — unlike
  everything else in teams.js.

  This app has no routing at all (confirmed: no query-string/hash/
  pushState usage anywhere before this file) — a single HTML page toggled
  by CSS classes. "?invite=TOKEN" / "?reset=TOKEN" are the first URL
  params this codebase has ever needed, so the persistence strategy is
  deliberately simple: read once at load, stash in localStorage (so the
  token survives a detour through an emailed password-reset link opened
  in a different tab/session, not just a same-tab reload), then strip the
  query string from the visible URL immediately.

  Reuses app.js's existing globals directly (loginScreen, appShell,
  authToken, currentUser, apiFetch, showMessage, loginUser, registerUser,
  activateApp/logoutLocalState) — no redeclaration, per this project's
  shared-global-scope convention. Every new name here is prefixed
  (invitation*, forgotPassword*, resetPassword*) to avoid collisions.
*/

const PENDING_INVITATION_KEY = "pendingInvitationToken";
const PENDING_RESET_KEY = "pendingResetToken";

const invitationPreviewBlock = document.getElementById("invitation-preview");
const invitationPreviewError = document.getElementById("invitation-preview-error");
const invitationPreviewTeamEl = document.getElementById("invitation-preview-team");
const invitationPreviewRoleEl = document.getElementById("invitation-preview-role");
const invitationPreviewCoachEl = document.getElementById("invitation-preview-coach");
const invitationLoginButtons = document.getElementById("invitation-login-buttons");
const invitationLoginHint = document.getElementById("invitation-login-hint");
const invitationAuthBtn = document.getElementById("invitation-auth-btn");
const loginButtonsBlock = document.getElementById("login-buttons");

const forgotPasswordLink = document.getElementById("forgot-password-link");
const forgotPasswordScreen = document.getElementById("forgot-password-screen");
const forgotPasswordEmailInput = document.getElementById("forgot-password-email-input");
const forgotPasswordSubmitBtn = document.getElementById("forgot-password-submit-btn");
const forgotPasswordConfirmation = document.getElementById("forgot-password-confirmation");
const forgotPasswordBackBtn = document.getElementById("forgot-password-back-btn");

const resetPasswordScreen = document.getElementById("reset-password-screen");
const resetPasswordInput = document.getElementById("reset-password-input");
const resetPasswordConfirmInput = document.getElementById("reset-password-confirm-input");
const resetPasswordSubmitBtn = document.getElementById("reset-password-submit-btn");
const resetPasswordError = document.getElementById("reset-password-error");

// Beta permissions incident fix: shown instead of silently auto-accepting
// when an invite link is opened while already logged in — see the
// showInvitationConfirmationIfPending()/acceptInvitationFromConfirmModal()
// pair below.
const invitationConfirmModal = document.getElementById("invitation-confirm-modal");
const invitationConfirmStepPreview = document.getElementById("invitation-confirm-step-preview");
const invitationConfirmStepMismatch = document.getElementById("invitation-confirm-step-mismatch");
const invitationConfirmTeamEl = document.getElementById("invitation-confirm-team");
const invitationConfirmRoleEl = document.getElementById("invitation-confirm-role");
const invitationConfirmCoachEl = document.getElementById("invitation-confirm-coach");
const invitationConfirmCurrentAccountEl = document.getElementById("invitation-confirm-current-account");
const invitationConfirmAcceptBtn = document.getElementById("invitation-confirm-accept-btn");
const invitationConfirmDismissBtn = document.getElementById("invitation-confirm-dismiss-btn");
const invitationConfirmMismatchMessage = document.getElementById("invitation-confirm-mismatch-message");
const invitationConfirmSwitchBtn = document.getElementById("invitation-confirm-switch-btn");
const invitationConfirmCancelBtn = document.getElementById("invitation-confirm-cancel-btn");
const invitationConfirmError = document.getElementById("invitation-confirm-error");

const INVITATION_ROLE_LABELS = { athlete: "Athlete", parent: "Parent", assistant_coach: "Assistant Coach" };

// Shows exactly one of the three pre-login screens (login/forgot/reset);
// never touches #app-shell, which activateApp()/logoutLocalState() in
// app.js already control independently.
function showPreLoginScreen(screenId) {
  [loginScreen, forgotPasswordScreen, resetPasswordScreen].forEach((section) => {
    section.classList.toggle("hidden", section.id !== screenId);
  });
}

// ---------- capture ?invite=/?reset= once, then clean the URL ----------

(function captureDeepLinkTokens() {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite");
  const resetToken = params.get("reset");

  if (inviteToken) localStorage.setItem(PENDING_INVITATION_KEY, inviteToken);
  if (resetToken) localStorage.setItem(PENDING_RESET_KEY, resetToken);

  if (inviteToken || resetToken) {
    history.replaceState(null, "", window.location.pathname);
  }
})();

// ---------- pre-login invitation preview ----------

async function showInvitationPreviewIfPending() {
  const token = localStorage.getItem(PENDING_INVITATION_KEY);
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/api/invitations/${token}`);
    const data = await res.json();

    if (!res.ok) {
      localStorage.removeItem(PENDING_INVITATION_KEY);
      invitationPreviewError.textContent = data.error || "This invitation link is no longer valid.";
      invitationPreviewError.classList.remove("hidden");
      return;
    }

    invitationPreviewTeamEl.textContent = data.teamName;
    invitationPreviewRoleEl.textContent = data.roleLabel || INVITATION_ROLE_LABELS[data.roleOnTeam] || data.roleOnTeam;
    invitationPreviewCoachEl.textContent = `Invited by ${data.coachName}`;
    invitationPreviewBlock.classList.remove("hidden");

    // Replaces the generic 3-role-button choice with a single button
    // locked to the invited role — the invitation already decided the
    // role, so asking the person to pick one themselves would be
    // confusing (and could register them with the wrong role).
    //
    // Existing-user multi-team invitation correction: this used to
    // always call handleAuth(), which tries login and silently falls
    // back to register() on ANY login failure -- including an existing
    // user simply not having typed their correct password yet. Since
    // users.email is UNIQUE, that fallback then threw on the duplicate
    // email and surfaced an opaque "Registration failed" with no path
    // forward for someone genuinely trying to accept a second-team
    // invitation. data.accountExists (server-computed, see
    // getInvitationPreview) now decides which single flow this button
    // takes, instead of guessing via try/catch — see
    // handleInvitedAuth() below.
    loginButtonsBlock.classList.add("hidden");
    invitationLoginButtons.classList.remove("hidden");

    if (data.accountExists) {
      invitationAuthBtn.textContent = "Log In to Accept";
      invitationLoginHint.textContent = "You already have a Cresamor account for this invitation — enter your existing password.";
    } else {
      invitationAuthBtn.textContent = `Continue as ${INVITATION_ROLE_LABELS[data.roleOnTeam] || data.roleOnTeam}`;
      invitationLoginHint.textContent = "";
    }
    invitationAuthBtn.onclick = () => handleInvitedAuth(data.roleOnTeam, data.accountExists);
  } catch (error) {
    console.error("Failed to load invitation preview:", error);
  }
}

// Existing-user multi-team invitation correction: the single-flow
// replacement for handleAuth() on the invitation screen specifically.
// accountExists === true takes a real login-only path with a clear
// error on failure (pointing at the existing Forgot Password flow);
// accountExists === false (or null, for a phone invitation, where the
// server has no comparable identity to check) keeps the original
// register-with-invited-role behavior. Never both in sequence — no
// guessing which one the person needs.
async function handleInvitedAuth(role, accountExists) {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    showMessage("Please enter both email and password.");
    return;
  }

  try {
    let data;

    if (accountExists) {
      try {
        data = await loginUser(email, password);
      } catch (loginError) {
        showMessage(
          'Incorrect email or password for this existing account. Use "Forgot password?" below if you don\'t remember it.'
        );
        return;
      }
    } else {
      data = await registerUser(email, password, role);
    }

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem("token", authToken);
    localStorage.setItem("user", JSON.stringify(currentUser));

    activateApp(currentUser);
  } catch (error) {
    console.error(error);
    showMessage(error.message || "Authentication failed.");
  }
}

// ---------- post-auth acceptance (runs after every successful login/register/reset) ----------

// Beta permissions incident fix: raw fetch(), not apiFetch() — apiFetch()'s
// error path only preserves { message, status }, discarding the rest of
// the JSON body, but the account-mismatch case needs invitedDestination
// out of a non-2xx response. Safe to auto-accept here without a
// confirmation step: this only ever runs right after a login/register
// that itself followed showInvitationPreviewIfPending()'s "Continue as
// X" button, i.e. the person already explicitly opted into THIS
// invitation before authenticating — the server-side destination check
// in acceptInvitation() is still the real authority either way (e.g. if
// they typed a different email at the registration form than the one
// they were invited on).
async function acceptPendingInvitationIfAny() {
  const token = localStorage.getItem(PENDING_INVITATION_KEY);
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/api/invitations/${token}/accept`, {
      method: "POST",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    const data = await res.json();

    if (res.status === 409 && data.error === "account_mismatch") {
      localStorage.removeItem(PENDING_INVITATION_KEY);
      showMessage(
        `This invitation was sent to ${data.invitedDestination}, but you're signed in as ${currentUser.email}. Ask your coach to send a new invite to this account, or log in as ${data.invitedDestination} instead.`
      );
      return;
    }

    if (!res.ok) {
      localStorage.removeItem(PENDING_INVITATION_KEY);
      showMessage(data.error || "That invitation link has expired or already been used. Ask your coach to send a new one.");
      return;
    }

    localStorage.removeItem(PENDING_INVITATION_KEY);

    if (typeof window.refreshTeamsAfterInviteAccept === "function") {
      window.refreshTeamsAfterInviteAccept();
    }

    switchToScreen("teams-screen");
    showMessage(
      data.alreadyMember
        ? `You're already part of ${data.team.name}.`
        : `You've joined ${data.team.name}!`
    );
  } catch (error) {
    console.error("Failed to accept pending invitation:", error);
    localStorage.removeItem(PENDING_INVITATION_KEY);
    showMessage("That invitation link has expired or already been used. Ask your coach to send a new one.");
  }
}

// ---------- invitation confirmation modal (already-logged-in case) ----------

// Beta permissions incident fix: this is what replaces the old silent
// auto-accept for an already-authenticated session. Never mutates
// anything by itself — only the explicit Accept button does, and the
// server (acceptInvitation()) is still the real authority on whether the
// currently signed-in account is actually allowed to accept this token.
async function showInvitationConfirmationIfPending() {
  const token = localStorage.getItem(PENDING_INVITATION_KEY);
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/api/invitations/${token}`);
    const data = await res.json();

    if (!res.ok) {
      localStorage.removeItem(PENDING_INVITATION_KEY);
      showMessage(data.error || "This invitation link is no longer valid.");
      return;
    }

    invitationConfirmTeamEl.textContent = data.teamName;
    invitationConfirmRoleEl.textContent = data.roleLabel || INVITATION_ROLE_LABELS[data.roleOnTeam] || data.roleOnTeam;
    invitationConfirmCoachEl.textContent = `Invited by ${data.coachName}`;
    invitationConfirmCurrentAccountEl.textContent = `You're currently signed in as ${currentUser.email}.`;

    invitationConfirmStepPreview.classList.remove("hidden");
    invitationConfirmStepMismatch.classList.add("hidden");
    invitationConfirmError.classList.add("hidden");
    invitationConfirmModal.classList.remove("hidden");
  } catch (error) {
    console.error("Failed to load invitation preview for confirmation:", error);
  }
}

async function acceptInvitationFromConfirmModal() {
  const token = localStorage.getItem(PENDING_INVITATION_KEY);
  if (!token) {
    invitationConfirmModal.classList.add("hidden");
    return;
  }

  invitationConfirmAcceptBtn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/invitations/${token}/accept`, {
      method: "POST",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    const data = await res.json();

    if (res.status === 409 && data.error === "account_mismatch") {
      invitationConfirmMismatchMessage.textContent =
        `This invitation was sent to ${data.invitedDestination}, but you're signed in as ${currentUser.email}.`;
      invitationConfirmStepPreview.classList.add("hidden");
      invitationConfirmStepMismatch.classList.remove("hidden");
      return;
    }

    if (!res.ok) {
      localStorage.removeItem(PENDING_INVITATION_KEY);
      invitationConfirmError.textContent = data.error || "That invitation link has expired or already been used.";
      invitationConfirmError.classList.remove("hidden");
      return;
    }

    localStorage.removeItem(PENDING_INVITATION_KEY);
    invitationConfirmModal.classList.add("hidden");

    if (typeof window.refreshTeamsAfterInviteAccept === "function") {
      window.refreshTeamsAfterInviteAccept();
    }

    switchToScreen("teams-screen");
    showMessage(
      data.alreadyMember
        ? `You're already part of ${data.team.name}.`
        : `You've joined ${data.team.name}!`
    );
  } catch (error) {
    console.error("Failed to accept invitation from confirm modal:", error);
    invitationConfirmError.textContent = "Something went wrong accepting this invitation. Please try again.";
    invitationConfirmError.classList.remove("hidden");
  } finally {
    invitationConfirmAcceptBtn.disabled = false;
  }
}

// ---------- forgot password ----------

function openForgotPasswordScreen() {
  forgotPasswordEmailInput.value = emailInput.value.trim();
  forgotPasswordConfirmation.classList.add("hidden");
  showPreLoginScreen("forgot-password-screen");
}

async function submitForgotPassword() {
  const email = forgotPasswordEmailInput.value.trim();
  if (!email) {
    showMessage("Please enter your email.");
    return;
  }

  forgotPasswordSubmitBtn.disabled = true;

  try {
    const data = await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    forgotPasswordConfirmation.textContent = data.message;
    forgotPasswordConfirmation.classList.remove("hidden");
  } catch (error) {
    console.error("Forgot-password request failed:", error);
    // Still show the same neutral confirmation copy — a distinguishable
    // error here would itself leak whether the email exists.
    forgotPasswordConfirmation.textContent =
      "If an account exists for that email, password reset instructions have been sent.";
    forgotPasswordConfirmation.classList.remove("hidden");
  } finally {
    forgotPasswordSubmitBtn.disabled = false;
  }
}

// ---------- reset password ----------

async function submitResetPassword() {
  const token = localStorage.getItem(PENDING_RESET_KEY);
  const newPassword = resetPasswordInput.value;
  const confirmPassword = resetPasswordConfirmInput.value;

  resetPasswordError.classList.add("hidden");

  if (!token) {
    resetPasswordError.textContent = "This reset link is missing or already used. Request a new one from the login screen.";
    resetPasswordError.classList.remove("hidden");
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    resetPasswordError.textContent = "Please choose a password with at least 6 characters.";
    resetPasswordError.classList.remove("hidden");
    return;
  }
  if (newPassword !== confirmPassword) {
    resetPasswordError.textContent = "Passwords don't match.";
    resetPasswordError.classList.remove("hidden");
    return;
  }

  resetPasswordSubmitBtn.disabled = true;

  try {
    const data = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });

    localStorage.removeItem(PENDING_RESET_KEY);

    // Treat exactly like a normal login success — same globals, same
    // localStorage keys, same activateApp() call — so the pending-
    // invitation check that's already wired into activateApp below runs
    // automatically from here too.
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem("token", authToken);
    localStorage.setItem("user", JSON.stringify(currentUser));
    activateApp(currentUser);

    showMessage("Your password has been reset and you're now logged in.");
  } catch (error) {
    console.error("Reset-password request failed:", error);
    resetPasswordError.textContent =
      "This link may have expired or already been used. Request a new password reset from the login screen.";
    resetPasswordError.classList.remove("hidden");
  } finally {
    resetPasswordSubmitBtn.disabled = false;
  }
}

// ---------- wiring ----------

forgotPasswordLink.addEventListener("click", openForgotPasswordScreen);
forgotPasswordSubmitBtn.addEventListener("click", submitForgotPassword);
forgotPasswordBackBtn.addEventListener("click", () => showPreLoginScreen("login-screen"));
resetPasswordSubmitBtn.addEventListener("click", submitResetPassword);

invitationConfirmAcceptBtn.addEventListener("click", acceptInvitationFromConfirmModal);
invitationConfirmDismissBtn.addEventListener("click", () => {
  invitationConfirmModal.classList.add("hidden");
});
invitationConfirmCancelBtn.addEventListener("click", () => {
  invitationConfirmModal.classList.add("hidden");
});
invitationConfirmSwitchBtn.addEventListener("click", () => {
  // Beta permissions incident fix: the token was never consumed (the
  // mismatch response mutates nothing), so it's still sitting in
  // localStorage — clearing the session and re-running the normal
  // logged-out preview flow picks it back up correctly for whichever
  // account logs in next.
  invitationConfirmModal.classList.add("hidden");
  if (typeof window.logoutLocalState === "function") {
    window.logoutLocalState();
  }
  showInvitationPreviewIfPending();
});

const __originalActivateAppForInvitations = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForInvitations(user);
  acceptPendingInvitationIfAny();
};

// ---------- startup ----------

if (localStorage.getItem(PENDING_RESET_KEY)) {
  showPreLoginScreen("reset-password-screen");
} else if (!authToken) {
  showInvitationPreviewIfPending();
} else if (currentUser) {
  // Covers the case where a session was already restored by app.js's own
  // restoreSession() call before this script finished loading — same
  // established precedent as home.js's identical fallback.
  //
  // Beta permissions incident fix: this used to call
  // acceptPendingInvitationIfAny() directly, silently accepting the
  // invitation using whatever account happened to already be logged in —
  // confirmed as the exact mechanism that let opening an invite meant for
  // one email silently rewrite a DIFFERENT, already-authenticated
  // account's team_members role (see acceptInvitation() in
  // server/services/invitations.js). Now shows an explicit confirmation
  // step first; the server is still the real authority regardless of
  // what this screen shows.
  showInvitationConfirmationIfPending();
}
