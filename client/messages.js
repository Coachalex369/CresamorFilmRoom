/*
  messages.js — real, conversation-scoped persistence for Messages.

  Direct Messaging Phase 2: this file previously drove a single Team-Chat
  thread with a team dropdown/label. It now owns a real inbox
  (#messages-inbox) listing every conversation the user can currently
  access -- both category='team' and category='direct' -- and a single
  shared active pane (#messages-active-pane, still the same
  #message-thread/#message-form elements as before) that renders
  whichever conversation is selected. Team Chat and Direct Messages are
  NOT separate code paths here: both categories fetch/send/mark-read
  through the exact same functions, because the server (Phase 1) already
  authorizes both uniformly once a conversation id is known -- the only
  per-category branch left on the client is cosmetic (message bubble
  styling; see renderMessageRow).

  directMessages.js (loaded after this file) owns the "New Message"
  recipient picker and the reusable window.openDirectMessage() entry
  point; it hands off to window.selectMessagesConversation() (exposed by
  this file) once a canonical DM conversation id is known. Phase 3 will
  intercept ONLY the direct-conversation case to render a floating
  AIM-style window instead of this inline pane -- selectConversation()
  and the inbox itself are the "client foundation" that hand-off point
  is built on.

  Keeps the exact same #message-thread DOM structure/classes for TEAM
  messages (.message-row, .coach-message/.player-message,
  .message-username, .message-bubble) so home.js's renderMessagesPreview()
  keeps working unmodified when a team conversation is the one selected
  -- see the note above appendNewMessages for the one known edge case
  this doesn't cover.

  Production bug fix (unchanged from before this phase): messages only
  showed up after a manual browser refresh — there was no live update
  mechanism at all. Polling: the active conversation every ~4s while the
  Messages screen is open, plus a slower ~12s conversation-list refresh
  (also what keeps the inbox rows' previews/unread counts and the nav
  badge current), both paused while the tab is hidden and stopped
  entirely when leaving Messages or logging out. Deliberately polling,
  not WebSockets/SSE — same "smallest reliable beta solution" reasoning
  as before, explicitly reaffirmed for Direct Messaging by the approved
  plan (section 10: "use the existing polling/refresh infrastructure").

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

const messagesInboxTeamList = document.querySelector("#messages-inbox-team-list");
const messagesInboxTeamEmpty = document.querySelector("#messages-inbox-team-empty");
const messagesInboxDirectList = document.querySelector("#messages-inbox-direct-list");
const messagesInboxDirectEmpty = document.querySelector("#messages-inbox-direct-empty");
const messagesActiveTitle = document.querySelector("#messages-active-title");
const messagesActiveContext = document.querySelector("#messages-active-context");
const messagesActivePlaceholder = document.querySelector("#messages-active-placeholder");
const messagesNavBadge = document.querySelector("#messages-nav-badge");

const MESSAGES_ROLE_LABELS = {
  coach: "Coach",
  assistant_coach: "Assistant Coach",
  athlete: "Athlete",
  parent: "Parent",
};

/* ---------- inbox state ----------
   Local to this file. `conversations` is the ONE array both the inbox
   list and the active pane read from — there is no separate per-category
   copy, matching the same "one fetched array, multiple views" discipline
   Schedule already established for Calendar/Agenda.
*/

let messagesInboxState = { conversations: [], selectedConversationId: null, selectedConversation: null };
let messagesConversationsLoaded = false;

function getSelectedConversationId() {
  return messagesInboxState.selectedConversationId;
}

function conversationDisplayName(conversation) {
  if (conversation.category === "team") return conversation.team_name || "Team Chat";
  if (conversation.category === "direct") return conversation.other_participant?.display_name || "Direct Message";
  return conversation.title || "Conversation";
}

function conversationContextLabel(conversation) {
  if (conversation.category === "team") return "Team Chat";
  if (conversation.category === "direct") {
    const role = conversation.other_participant?.role;
    return role ? MESSAGES_ROLE_LABELS[role] || role : "Direct Message";
  }
  return "";
}

function formatInboxTimestamp(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });
}

/* ---------- inbox rendering ---------- */

function renderInboxRow(conversation) {
  const li = document.createElement("li");
  li.className = "messages-inbox-item";
  if (conversation.id === messagesInboxState.selectedConversationId) {
    li.classList.add("messages-inbox-item-selected");
  }
  if (Number(conversation.unread_count) > 0) {
    li.classList.add("messages-inbox-item-unread");
  }

  const main = document.createElement("div");
  main.className = "messages-inbox-item-main";

  const nameRow = document.createElement("div");
  nameRow.className = "messages-inbox-item-name-row";

  const nameEl = document.createElement("span");
  nameEl.className = "messages-inbox-item-name";
  nameEl.textContent = conversationDisplayName(conversation);

  const timeEl = document.createElement("span");
  timeEl.className = "messages-inbox-item-time";
  timeEl.textContent = formatInboxTimestamp(conversation.last_message_at);

  nameRow.appendChild(nameEl);
  nameRow.appendChild(timeEl);

  const contextEl = document.createElement("span");
  contextEl.className = "messages-inbox-item-context";
  contextEl.textContent = conversationContextLabel(conversation);

  const previewEl = document.createElement("p");
  previewEl.className = "messages-inbox-item-preview";
  previewEl.textContent = conversation.last_message_preview || "No messages yet.";

  main.appendChild(nameRow);
  main.appendChild(contextEl);
  main.appendChild(previewEl);
  li.appendChild(main);

  const unread = Number(conversation.unread_count);
  if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "messages-inbox-unread-badge";
    badge.textContent = unread > 9 ? "9+" : String(unread);
    li.appendChild(badge);
  }

  // Team Chat keeps opening in the shared inline pane below; a Direct
  // Message now opens/focuses its own floating window (desktop) or the
  // mobile overlay instead — see window.selectMessagesConversation's own
  // category branch, which both this row click and openDirectMessage()
  // funnel through, so the two entry points can never disagree about
  // where a given conversation opens.
  li.addEventListener("click", () => window.selectMessagesConversation(conversation.id));
  return li;
}

function renderInbox() {
  if (!messagesInboxTeamList || !messagesInboxDirectList) return;

  const teamConversations = messagesInboxState.conversations.filter((c) => c.category === "team");
  const directConversations = messagesInboxState.conversations.filter((c) => c.category === "direct");

  messagesInboxTeamList.innerHTML = "";
  teamConversations.forEach((c) => messagesInboxTeamList.appendChild(renderInboxRow(c)));
  messagesInboxTeamEmpty.classList.toggle("hidden", teamConversations.length > 0);

  messagesInboxDirectList.innerHTML = "";
  directConversations.forEach((c) => messagesInboxDirectList.appendChild(renderInboxRow(c)));
  messagesInboxDirectEmpty.classList.toggle("hidden", directConversations.length > 0);

  renderNavBadge();
}

// Main Messages nav tab badge (section 10) — the sum of every accessible
// conversation's unread_count, the exact same field the inbox rows
// already render individually. No separate endpoint: this is what
// "use the existing polling/refresh infrastructure" means concretely —
// pollConversationList()'s regular GET /api/conversations already
// carries everything this needs.
function renderNavBadge() {
  if (!messagesNavBadge) return;
  const total = messagesInboxState.conversations.reduce((sum, c) => sum + Number(c.unread_count || 0), 0);
  messagesNavBadge.textContent = total > 9 ? "9+" : String(total);
  messagesNavBadge.classList.toggle("hidden", total === 0);
}

function renderActiveHeader() {
  const conversation = messagesInboxState.selectedConversation;
  if (!conversation) {
    messagesActiveTitle.classList.add("hidden");
    messagesActiveContext.classList.add("hidden");
    return;
  }

  messagesActiveTitle.textContent = conversationDisplayName(conversation);
  messagesActiveTitle.classList.remove("hidden");
  messagesActiveContext.textContent = conversationContextLabel(conversation);
  messagesActiveContext.classList.remove("hidden");
}

function showEmptyActivePane() {
  messagesActivePlaceholder.classList.remove("hidden");
  realMessageThread.classList.add("hidden");
  realMessageForm?.classList.add("hidden");
  messagesActiveTitle.classList.add("hidden");
  messagesActiveContext.classList.add("hidden");
}

/* ---------- loading conversations (the inbox's one data source) ---------- */

async function loadConversations() {
  if (!currentUser) return;

  try {
    const conversations = await apiFetch("/api/conversations");
    messagesInboxState.conversations = conversations || [];

    if (messagesInboxState.selectedConversationId) {
      const stillPresent = messagesInboxState.conversations.find(
        (c) => c.id === messagesInboxState.selectedConversationId
      );
      messagesInboxState.selectedConversation = stillPresent || null;

      // A conversation can legitimately disappear from this list without
      // any message being deleted — Phase 1's live reauthorization drops
      // a direct conversation whose relationship has since lapsed, and a
      // revoked team member's team chat the same way. History persists
      // server-side either way; the client just stops showing it.
      if (!stillPresent) {
        messagesInboxState.selectedConversationId = null;
        showEmptyActivePane();
      }
    }

    renderInbox();
    renderActiveHeader();
  } catch (error) {
    console.error("Failed to load conversations for Messages:", error);
  }
}

// First-time default: land on the first Team Chat, same habitual
// behavior as before this phase (a single-team coach opening Messages
// used to always see their team thread immediately). Never
// auto-selects a Direct Message — those are opened deliberately, via an
// inbox click or openDirectMessage(), not guessed at.
async function ensureInitialSelection() {
  if (messagesInboxState.selectedConversationId) return;

  const firstTeamConversation = messagesInboxState.conversations.find((c) => c.category === "team");
  if (firstTeamConversation) {
    await selectConversation(firstTeamConversation.id);
  } else {
    showEmptyActivePane();
  }
}

async function initMessagesScreen() {
  if (!currentUser) return;

  await loadConversations();
  messagesConversationsLoaded = true;
  await ensureInitialSelection();
}

/* ---------- selecting a conversation (shared by inbox clicks AND
   openDirectMessage()) ---------- */

async function selectConversation(conversationId) {
  const conversation = messagesInboxState.conversations.find((c) => c.id === conversationId);

  messagesInboxState.selectedConversationId = conversationId;
  messagesInboxState.selectedConversation = conversation || null;

  renderInbox();
  renderActiveHeader();

  messagesActivePlaceholder.classList.add("hidden");
  realMessageThread.classList.remove("hidden");
  realMessageForm?.classList.remove("hidden");

  realMessageThread.innerHTML = "";
  renderedMessageIds.clear();

  await loadMessages();
}

// The one shared "open/show this conversation" entry point — used by
// inbox row clicks AND by directMessages.js's openDirectMessage() once
// it has a real conversation id from POST /api/direct-messages. A
// brand-new canonical thread won't be in messagesInboxState yet (it was
// just created), so this refreshes the list first when needed. Branches
// by category so the two call sites can never disagree about WHERE a
// conversation opens: Team Chat -> the shared inline pane (unchanged
// since Phase 2); Direct Message -> a floating window (desktop) or the
// full-screen mobile overlay, owned by directMessages.js — this file
// never renders DM content itself as of Phase 3.
window.selectMessagesConversation = async function (conversationId) {
  if (!messagesInboxState.conversations.some((c) => c.id === conversationId)) {
    await loadConversations();
  }

  const conversation = messagesInboxState.conversations.find((c) => c.id === conversationId);
  if (!conversation) return;

  if (conversation.category === "direct") {
    if (typeof window.openDirectMessageWindow === "function") {
      window.openDirectMessageWindow(conversation);
    }
    return;
  }

  await selectConversation(conversationId);
};

// directMessages.js calls this after marking a DM read (or seeing new
// messages) so the inbox rows and nav badge reflect it promptly instead
// of waiting for the next CONVERSATION_LIST_POLL_INTERVAL_MS tick — same
// reasoning as the send-handler's own immediate loadConversations() call
// above.
window.refreshMessagesConversations = loadConversations;

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

// Team messages keep their original role-based styling/classes exactly
// (home.js's renderMessagesPreview() DOM-scrapes .coach-message off
// #message-thread — see this file's header note). Direct messages use a
// sender-based own/theirs distinction instead, since "coach vs everyone
// else" has no meaning for a 1:1 thread between two arbitrary people —
// this is also the sender-distinction Phase 3's AIM windows will reuse.
function renderMessageRow(message) {
  const row = document.createElement("div");
  const isDirect = messagesInboxState.selectedConversation?.category === "direct";

  if (isDirect) {
    const isMine = currentUser && Number(message.sender_id) === Number(currentUser.id);
    row.className = `message-row ${isMine ? "own-message" : "their-message"}`;
  } else {
    row.className = `message-row ${message.role === "coach" ? "coach-message" : "player-message"}`;
  }

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

function afterNewMessagesRendered() {
  if (typeof window.renderMessagesPreview === "function") {
    window.renderMessagesPreview();
  }

  // "Read" corresponds to the user actually viewing the conversation —
  // this only fires from loadMessages() (a deliberate open/select) and
  // the visible-poll path below, both gated on the Messages screen
  // actually being the active tab; a background list-only poll never
  // calls this (see pollConversationList — it never touches read state).
  if (typeof window.markCurrentConversationRead === "function") {
    window.markCurrentConversationRead();
  }
}

// Full load: used when selecting a conversation and after sending —
// always resets and re-renders the whole thread, and always jumps to the
// bottom (a deliberate user action, unlike a background poll tick).
async function loadMessages() {
  if (!realMessageThread) return;

  const conversationId = getSelectedConversationId();
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
    const conversationId = getSelectedConversationId();
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

// Slower list refresh — keeps every inbox row's preview/timestamp/unread
// count current, keeps the nav badge current, catches a brand-new
// incoming DM from someone else, and (same as before this phase) catches
// a relationship change (team revocation, or now a lapsed DM
// eligibility) that happens WHILE the user is actively in Messages —
// loadConversations() re-derives the whole list from the server's live
// answer every time, never trusting stale client state. Deliberately
// never marks anything read — see afterNewMessagesRendered's comment.
async function pollConversationList() {
  if (conversationListPollBusy) return;
  conversationListPollBusy = true;

  try {
    if (!currentUser) return;
    await loadConversations();
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
// re-validates the inbox (team/relationship changes since last visit,
// same discipline as Schedule's initScheduleScreen) and starts polling;
// leaving it stops both timers.
document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => {
    messagesScreenActive = button.dataset.screen === "messages-screen";
    if (messagesScreenActive) {
      initMessagesScreen();
    }
    refreshPollingState({ immediate: true });
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
// pattern as window.renderMessagesPreview above. Marks whichever
// conversation is currently selected, if any; a no-op otherwise (there
// is no longer a single universal "current" conversation to fall back
// to now that Messages is a real multi-thread inbox).
window.markCurrentConversationRead = async function () {
  const conversationId = getSelectedConversationId();
  if (!conversationId || !currentUser) return;

  try {
    await apiFetch(`/api/conversations/${conversationId}/read`, {
      method: "PUT",
    });
    // Reflect the read state in this device's own badge/rows immediately
    // rather than waiting for the next list poll.
    const conversation = messagesInboxState.conversations.find((c) => c.id === conversationId);
    if (conversation) {
      conversation.unread_count = 0;
      renderInbox();
    }
  } catch (error) {
    console.error("Failed to mark conversation read:", error);
  }
};

if (realMessageForm) {
  realMessageForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const body = realMessageBodyInput.value.trim();

    if (!body) return;

    const conversationId = getSelectedConversationId();

    if (!conversationId) {
      showMessage("Select a conversation first.");
      return;
    }

    // Blank-message prevention (above) and accidental-duplicate-send
    // prevention: disable the control for the duration of the request
    // rather than relying on the user not double-clicking.
    if (realMessageSubmitBtn) realMessageSubmitBtn.disabled = true;

    try {
      await apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });

      realMessageBodyInput.value = "";
      await loadMessages();
      // Refresh the inbox row's own preview/timestamp immediately rather
      // than waiting up to CONVERSATION_LIST_POLL_INTERVAL_MS for the
      // sender to see their own just-sent message reflected there.
      await loadConversations();
    } catch (error) {
      console.error("Failed to send message:", error);
      showMessage("Could not send message. Please try again.");
    } finally {
      if (realMessageSubmitBtn) realMessageSubmitBtn.disabled = false;
    }
  });
}

const __originalActivateAppForMessages = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForMessages(user);
  // Reset on login so a different user re-resolves their own conversations
  // from scratch, not whatever the previous session had —
  // messagesConversationsLoaded=false is what makes initMessagesScreen()
  // actually refetch instead of trusting stale state.
  messagesConversationsLoaded = false;
  messagesInboxState = { conversations: [], selectedConversationId: null, selectedConversation: null };
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
  messagesConversationsLoaded = false;
  messagesInboxState = { conversations: [], selectedConversationId: null, selectedConversation: null };
  __originalLogoutLocalStateForMessages();
};

// Covers the case where a session was already restored by app.js's own
// restoreSession() call before this script finished loading.
if (currentUser) {
  initMessagesScreen();
}
