/*
  messages.js — real, conversation-scoped persistence for Team Messages.

  Foundation Sprint Phase 2: previously (Sprint 3) this called the flat
  GET/POST /api/messages endpoints. Those are now retired — the backend is
  built around Conversations -> Conversation Participants -> Messages (see
  CLAUDE.md). The MVP UI still only ever shows one thread, but the
  underlying calls are genuinely conversation-scoped and permission-checked
  server-side now (a user who isn't a participant gets a real 403, not just
  "the UI doesn't show a picker").

  Production bug fix: messages only showed up after a manual browser
  refresh — there was no live update mechanism at all. Adds polling: the
  active conversation every ~4s while the Messages screen is open, plus a
  slower ~12s conversation-list/metadata refresh (mainly for Home's
  preview block), both paused while the tab is hidden and stopped
  entirely when leaving Messages or logging out. Deliberately polling, not
  WebSockets/SSE — "smallest reliable beta solution" per the brief; a real
  push mechanism is a bigger, separate architectural change.

  Keeps the exact same DOM structure/classes (.message-row, .coach-message /
  .player-message, .message-username, .message-bubble) so home.js's
  renderMessagesPreview() keeps working completely unmodified.

  NOTE: every top-level const here is prefixed `real*` deliberately — app.js
  already declares its own messageForm/messageInput/messageThread/etc. for
  its old (now superseded) local-only handler. Plain <script> tags share one
  global lexical scope, so reusing those exact names throws a SyntaxError
  ("Identifier has already been declared") that silently kills this whole
  file. Don't rename these back to match app.js's names.
*/

const realMessageThread = document.querySelector("#message-thread");
const staleMessageForm = document.querySelector("#message-form");

// The original message-form submit listener (in app.js) only appends a
// local, non-persisted row. Cloning the form strips that listener without
// editing app.js's source — only this file's real, persisting handler runs.
const realMessageForm = staleMessageForm ? staleMessageForm.cloneNode(true) : null;

if (staleMessageForm && realMessageForm) {
  staleMessageForm.replaceWith(realMessageForm);
}

const realMessageBodyInput = realMessageForm?.querySelector("#message-input");
const realMessageSubmitBtn = realMessageForm?.querySelector('button[type="submit"]');

const messagesTeamLabel = document.querySelector("#messages-team-label");
const messagesTeamSelectLabel = document.querySelector("#messages-team-select-label");
const messagesTeamSelect = document.querySelector("#messages-team-select");
const messagesTeamEmpty = document.querySelector("#messages-team-empty");
const messagesComposeContext = document.querySelector("#messages-compose-context");

/* ---------- team-scoped conversation state ----------
   Local to this file, deliberately not shared with teams.js/capture.js —
   Messages gets its own team selector, not a global "current team"
   context (that's a separate future decision, not part of this feature).
*/

let messagesTeamState = { myTeams: [], conversations: [], selectedTeamId: null };
let messagesTeamsLoaded = false;

const MESSAGES_TEAM_STORAGE_KEY = "cresamor_messages_selected_team";

function getStoredTeamPreference() {
  const raw = localStorage.getItem(MESSAGES_TEAM_STORAGE_KEY);
  return raw ? Number(raw) : null;
}

// The stored value is only ever a PREFERENCE, never authorization — every
// call site that sets it also just finished validating it against the
// server's own myTeams list (see loadMessagesTeamsAndConversations).
// localStorage itself grants nothing; it only shapes which already-
// authorized team is pre-selected.
function setSelectedTeam(teamId) {
  messagesTeamState.selectedTeamId = teamId;
  if (teamId) {
    localStorage.setItem(MESSAGES_TEAM_STORAGE_KEY, String(teamId));
  } else {
    localStorage.removeItem(MESSAGES_TEAM_STORAGE_KEY);
  }
}

// Recomputed fresh from current state every time it's called — never
// cached in a variable that could go stale between a team switch and a
// message send. This is what guarantees a message can never be
// associated with the wrong team: the server independently re-checks
// team membership for whatever conversation_id this resolves to, but
// this is the client-side half of "never accidentally Team B."
function getSelectedConversationId() {
  if (!messagesTeamState.selectedTeamId) return null;
  const conversation = messagesTeamState.conversations.find(
    (c) => Number(c.team_id) === Number(messagesTeamState.selectedTeamId)
  );
  return conversation ? conversation.id : null;
}

function teamDisplayLabel(team) {
  // "Do not rely on names alone" — pair the name with sport (and school,
  // if present) so two similarly-named teams are never ambiguous. Same
  // pattern teams.js already uses for its own team meta line.
  return [team.name, team.sport, team.school_name].filter(Boolean).join(" — ");
}

function renderMessagesTeamContext() {
  if (!messagesTeamLabel) return;

  const teams = messagesTeamState.myTeams;

  messagesTeamLabel.classList.add("hidden");
  messagesTeamSelectLabel.classList.add("hidden");
  messagesTeamSelect.classList.add("hidden");
  messagesTeamEmpty.classList.add("hidden");
  messagesComposeContext.classList.add("hidden");

  if (!teams.length) {
    messagesTeamEmpty.classList.remove("hidden");
    if (realMessageBodyInput) realMessageBodyInput.disabled = true;
    if (realMessageSubmitBtn) realMessageSubmitBtn.disabled = true;
    return;
  }

  if (realMessageBodyInput) realMessageBodyInput.disabled = false;
  if (realMessageSubmitBtn) realMessageSubmitBtn.disabled = false;

  const selectedTeam = teams.find((t) => Number(t.id) === Number(messagesTeamState.selectedTeamId));

  // Single-team users see identity with no selection control at all — no
  // unnecessary friction. Multi-team users get a real <select>.
  if (teams.length === 1) {
    messagesTeamLabel.textContent = teamDisplayLabel(teams[0]);
    messagesTeamLabel.classList.remove("hidden");
  } else {
    messagesTeamSelectLabel.classList.remove("hidden");
    messagesTeamSelect.classList.remove("hidden");
    messagesTeamSelect.innerHTML = "";
    teams.forEach((team) => {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = teamDisplayLabel(team);
      option.selected = Number(team.id) === Number(messagesTeamState.selectedTeamId);
      messagesTeamSelect.appendChild(option);
    });
  }

  // Persistent identity right at the compose point, not just at the top
  // of the screen — separate from the label/select above so it stays
  // visible even if the user has scrolled through a long thread.
  if (selectedTeam) {
    messagesComposeContext.textContent = `Sending as: ${teamDisplayLabel(selectedTeam)}`;
    messagesComposeContext.classList.remove("hidden");
  }
}

// Fetches the user's real, currently-active teams AND their visible
// conversations together, then resolves which team is selected. The
// stored localStorage preference is validated against myTeams (the
// server's live answer) every single time this runs — a team the user
// no longer belongs to is silently discarded in favor of a real one,
// never trusted as-is.
async function loadMessagesTeamsAndConversations() {
  if (!currentUser) return;

  try {
    const [myTeams, conversations] = await Promise.all([
      apiFetch(`/api/users/${currentUser.id}/teams`),
      apiFetch("/api/conversations"),
    ]);

    messagesTeamState.myTeams = myTeams || [];
    messagesTeamState.conversations = conversations || [];

    const stored = getStoredTeamPreference();
    const storedIsValid = stored && messagesTeamState.myTeams.some((t) => Number(t.id) === Number(stored));

    if (storedIsValid) {
      setSelectedTeam(stored);
    } else if (messagesTeamState.myTeams.length) {
      setSelectedTeam(messagesTeamState.myTeams[0].id);
    } else {
      setSelectedTeam(null);
    }

    renderMessagesTeamContext();
  } catch (error) {
    console.error("Failed to load teams/conversations for Messages:", error);
  }
}

if (messagesTeamSelect) {
  messagesTeamSelect.addEventListener("change", async () => {
    const newTeamId = Number(messagesTeamSelect.value);
    setSelectedTeam(newTeamId);
    renderMessagesTeamContext();

    realMessageThread.innerHTML = "";
    renderedMessageIds.clear();
    await loadMessages();
  });
}

/* ---------- polling state ---------- */

const MESSAGE_POLL_INTERVAL_MS = 4000; // 3-5s range
const CONVERSATION_LIST_POLL_INTERVAL_MS = 12000; // 10-15s range
const NEAR_BOTTOM_THRESHOLD_PX = 80;

let messagesScreenActive = false;
let messagePollTimer = null;
let conversationListPollTimer = null;
let messagePollBusy = false; // overlap guard — same check-then-set pattern as recordingPipeline.js
let conversationListPollBusy = false;
const renderedMessageIds = new Set();

function isNearBottom() {
  if (!realMessageThread) return true;
  return (
    realMessageThread.scrollHeight - realMessageThread.scrollTop - realMessageThread.clientHeight <
    NEAR_BOTTOM_THRESHOLD_PX
  );
}

function renderMessageRow(message) {
  const row = document.createElement("div");
  row.className = `message-row ${message.role === "coach" ? "coach-message" : "player-message"}`;

  const usernameEl = document.createElement("p");
  usernameEl.className = "message-username";
  usernameEl.textContent = message.username;

  const bubbleEl = document.createElement("p");
  bubbleEl.className = "message-bubble";
  bubbleEl.textContent = message.body;

  row.appendChild(usernameEl);
  row.appendChild(bubbleEl);
  return row;
}

// Appends only messages not already rendered (tracked by id) — the
// dedup mechanism, and what makes scroll-position preservation "free":
// unlike a full innerHTML wipe-and-rebuild, appending to the end of a
// container the user has scrolled up in doesn't move their scroll
// position at all. Auto-scrolls to the new bottom only if the user was
// already near the bottom before new rows landed. Returns how many rows
// were actually appended, so callers can tell "nothing changed" apart
// from "something did".
function appendNewMessages(messages) {
  if (!realMessageThread) return 0;

  const wasNearBottom = isNearBottom();
  let appended = 0;

  (Array.isArray(messages) ? messages : []).forEach((message) => {
    if (renderedMessageIds.has(message.id)) return;
    renderedMessageIds.add(message.id);
    realMessageThread.appendChild(renderMessageRow(message));
    appended += 1;
  });

  if (appended > 0 && wasNearBottom) {
    realMessageThread.scrollTop = realMessageThread.scrollHeight;
  }

  return appended;
}

// Team-scoping fix: this used to cache a single currentConversationId for
// the whole session — whichever conversation the DB happened to return
// first, ignoring team entirely, and never re-resolved after that. There
// is deliberately no conversation-ID cache anymore: the selected team
// (messagesTeamState.selectedTeamId) is the only source of truth, and
// getSelectedConversationId() re-derives the conversation from it fresh
// on every call. This function's only remaining job is making sure
// team/conversation data has been loaded at least once per session
// (messagesTeamsLoaded — not once per poll tick).
async function ensureCurrentConversation() {
  if (!currentUser) return null;

  if (!messagesTeamsLoaded) {
    await loadMessagesTeamsAndConversations();
    messagesTeamsLoaded = true;
  }

  return getSelectedConversationId();
}

function afterNewMessagesRendered() {
  if (typeof window.renderMessagesPreview === "function") {
    window.renderMessagesPreview();
  }

  if (typeof window.markCurrentConversationRead === "function") {
    window.markCurrentConversationRead();
  }
}

// Full load: used for the initial fetch (login/session restore) and for
// sending a message — always resets and re-renders the whole thread, and
// always jumps to the bottom (a deliberate user action, unlike a
// background poll tick).
async function loadMessages() {
  if (!realMessageThread) return;

  const conversationId = await ensureCurrentConversation();
  if (!conversationId || !currentUser) return;

  try {
    const messages = await apiFetch(`/api/conversations/${conversationId}/messages`);

    realMessageThread.innerHTML = "";
    renderedMessageIds.clear();
    appendNewMessages(messages);
    realMessageThread.scrollTop = realMessageThread.scrollHeight;

    afterNewMessagesRendered();
  } catch (error) {
    console.error("Failed to load messages:", error);
  }
}

// Background poll tick: append-only, no reset, no forced scroll — see
// appendNewMessages(). A 401 here is a defense-in-depth stop (apiFetch's
// own global 401 handler already triggers logout); this just makes sure
// polling doesn't keep firing in the meantime.
async function pollActiveConversation() {
  if (messagePollBusy) return;
  messagePollBusy = true;

  try {
    const conversationId = await ensureCurrentConversation();
    if (!conversationId || !currentUser) return;

    const messages = await apiFetch(`/api/conversations/${conversationId}/messages`);
    const appended = appendNewMessages(messages);

    if (appended > 0) {
      afterNewMessagesRendered();
    }
  } catch (error) {
    if (error?.status === 401) {
      stopMessagePolling();
      return;
    }
    console.error("Message poll failed:", error);
  } finally {
    messagePollBusy = false;
  }
}

// Slower metadata refresh — keeps Home's messages preview fresh, and
// (team-scoping fix) is also what catches a team revocation that happens
// WHILE the user is actively viewing Messages: loadMessagesTeamsAndConversations()
// re-validates the selected team against the server's live myTeams list
// every time this runs, so a revoked team is silently dropped and a real
// remaining team (or none) takes its place, same fallback logic as the
// initial load — never trusting stale client state.
async function pollConversationList() {
  if (conversationListPollBusy) return;
  conversationListPollBusy = true;

  try {
    if (!currentUser) return;

    const previousSelectedTeamId = messagesTeamState.selectedTeamId;
    await loadMessagesTeamsAndConversations();

    if (Number(messagesTeamState.selectedTeamId) !== Number(previousSelectedTeamId)) {
      // The previously selected team is no longer valid (e.g. revoked
      // mid-session) — reload the thread for whichever team the
      // fallback landed on (or clear it if the user now has none).
      realMessageThread.innerHTML = "";
      renderedMessageIds.clear();
      await loadMessages();
    }

    if (typeof window.renderMessagesPreview === "function") {
      window.renderMessagesPreview();
    }
  } catch (error) {
    if (error?.status === 401) {
      stopMessagePolling();
      return;
    }
    console.error("Conversation list poll failed:", error);
  } finally {
    conversationListPollBusy = false;
  }
}

function startMessagePolling() {
  if (!messagePollTimer) {
    messagePollTimer = setInterval(pollActiveConversation, MESSAGE_POLL_INTERVAL_MS);
  }
  if (!conversationListPollTimer) {
    conversationListPollTimer = setInterval(pollConversationList, CONVERSATION_LIST_POLL_INTERVAL_MS);
  }
}

function stopMessagePolling() {
  if (messagePollTimer) {
    clearInterval(messagePollTimer);
    messagePollTimer = null;
  }
  if (conversationListPollTimer) {
    clearInterval(conversationListPollTimer);
    conversationListPollTimer = null;
  }
}

// Polling should only actually run when the Messages screen is the
// selected tab AND the tab/window is visible AND someone's logged in —
// any other combination stops both timers. Called from the tab-click
// listener, visibilitychange, window focus, and login/logout.
function refreshPollingState({ immediate = false } = {}) {
  const shouldPoll = messagesScreenActive && document.visibilityState === "visible" && Boolean(currentUser);

  if (shouldPoll) {
    startMessagePolling();
    if (immediate) {
      pollActiveConversation();
      pollConversationList();
    }
  } else {
    stopMessagePolling();
  }
}

// Independent listener on the same tab buttons app.js already wires —
// this doesn't touch app.js's own click handler, just observes the same
// clicks (multiple listeners on one element is fine). Entering Messages
// starts polling with an immediate refresh; leaving it stops both timers.
document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => {
    messagesScreenActive = button.dataset.screen === "messages-screen";
    refreshPollingState({ immediate: true });
    // Opening the Messages tab should land at the newest message every
    // time, not just on login/session-restore or right after sending —
    // scrollTop/scrollHeight only, no re-fetch, so dedup state is untouched.
    if (messagesScreenActive && realMessageThread) {
      realMessageThread.scrollTop = realMessageThread.scrollHeight;
    }
  });
});

// Pause while hidden, immediately refresh (not just resume) the instant
// the tab becomes visible again.
document.addEventListener("visibilitychange", () => {
  refreshPollingState({ immediate: document.visibilityState === "visible" });
});

window.addEventListener("focus", () => {
  refreshPollingState({ immediate: true });
});

// Exposed so home.js's "View All Messages" click can mark the conversation
// read server-side (real, cross-device unread state) in addition to its
// existing local unread-badge reset — loose coupling via window, same
// pattern as window.renderMessagesPreview above.
window.markCurrentConversationRead = async function () {
  const conversationId = await ensureCurrentConversation();
  if (!conversationId || !currentUser) return;

  try {
    await apiFetch(`/api/conversations/${conversationId}/read`, {
      method: "PUT",
    });
  } catch (error) {
    console.error("Failed to mark conversation read:", error);
  }
};

if (realMessageForm) {
  realMessageForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const body = realMessageBodyInput.value.trim();

    if (!body) return;

    // Always resolved fresh from the currently selected team at the
    // moment of sending — ensureCurrentConversation() no longer caches a
    // conversation id, so a team switch mid-compose can never result in
    // a message landing in the wrong team's conversation.
    const conversationId = await ensureCurrentConversation();

    if (!conversationId) {
      showMessage("No team conversation available yet.");
      return;
    }

    try {
      await apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });

      realMessageBodyInput.value = "";
      await loadMessages();
    } catch (error) {
      console.error("Failed to send message:", error);
      showMessage("Could not send message. Please try again.");
    }
  });
}

const __originalActivateAppForMessages = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForMessages(user);
  // Reset on login so a different user re-resolves their own teams and
  // conversations from scratch, not whatever the previous session had —
  // messagesTeamsLoaded=false is what makes ensureCurrentConversation()
  // actually refetch instead of trusting stale state.
  messagesTeamsLoaded = false;
  messagesTeamState = { myTeams: [], conversations: [], selectedTeamId: null };
  loadMessages();
  refreshPollingState();
};

// Stops polling on both an explicit user logout AND the 401-triggered
// auto-logout apiFetch performs — both paths call window.logoutLocalState,
// so hooking it once covers both. Same wrap-and-chain pattern as
// window.activateApp above; home.js also wraps this function and loads
// after this file, so both wrappers chain regardless of load order.
const __originalLogoutLocalStateForMessages = window.logoutLocalState;
window.logoutLocalState = function () {
  stopMessagePolling();
  messagesScreenActive = false;
  messagesTeamsLoaded = false;
  messagesTeamState = { myTeams: [], conversations: [], selectedTeamId: null };
  __originalLogoutLocalStateForMessages();
};

if (currentUser) {
  loadMessages();
}
