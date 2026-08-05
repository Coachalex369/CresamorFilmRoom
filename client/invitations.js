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
  authToken, currentUser, apiFetch, showMessage, handleAuth,
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
    // confusing (and could register them with the wrong role). This
    // button still tries LOGIN first (handleAuth doesn't send a role for
    // login), so an existing account works exactly the same as it always
    // has; only a brand-new account gets the invited role.
    loginButtonsBlock.classList.add("hidden");
    invitationLoginButtons.classList.remove("hidden");
    invitationAuthBtn.textContent = `Continue as ${INVITATION_ROLE_LABELS[data.roleOnTeam] || data.roleOnTeam}`;
    invitationAuthBtn.onclick = () => handleAuth(data.roleOnTeam);
  } catch (error) {
    console.error("Failed to load invitation preview:", error);
  }
}

// ---------- post-auth acceptance (runs after every successful login/register/reset) ----------

async function acceptPendingInvitationIfAny() {
  const token = localStorage.getItem(PENDING_INVITATION_KEY);
  if (!token) return;

  try {
    const result = await apiFetch(`/api/invitations/${token}/accept`, { method: "POST" });
    localStorage.removeItem(PENDING_INVITATION_KEY);

    if (typeof window.refreshTeamsAfterInviteAccept === "function") {
      window.refreshTeamsAfterInviteAccept();
    }

    switchToScreen("teams-screen");
    showMessage(
      result.alreadyMember
        ? `You're already part of ${result.team.name}.`
        : `You've joined ${result.team.name}!`
    );
  } catch (error) {
    console.error("Failed to accept pending invitation:", error);
    localStorage.removeItem(PENDING_INVITATION_KEY);
    showMessage("That invitation link has expired or already been used. Ask your coach to send a new one.");
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
  // established precedent as home.js's identical fallback. Without this,
  // a pending invitation token sitting in localStorage from an earlier
  // visit would never get accepted for an already-logged-in returning user.
  acceptPendingInvitationIfAny();
}
