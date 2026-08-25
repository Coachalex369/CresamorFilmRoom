/*
  directMessages.js — Direct Messaging Phase 3: floating AIM-style
  windows (desktop) and a full-screen overlay (mobile), plus the "New
  Message" recipient picker and the reusable window.openDirectMessage()
  entry point from Phase 2.

  Architecture note: #dm-windows-container and #dm-mobile-overlay live
  OUTSIDE every .app-screen in index.html specifically so they survive
  tab navigation — a .app-screen gets display:none the instant it's not
  the active tab, which would silently kill an "open" conversation the
  moment the user clicked Home. This file owns both presentations
  directly; messages.js's inline pane (#message-thread) is now Team-Chat
  -only — window.selectMessagesConversation() branches by category and
  hands a category='direct' conversation to
  window.openDirectMessageWindow() here instead of ever touching the
  inline pane.

  Desktop vs. mobile is decided ONCE, at open time, from the same
  700px breakpoint the rest of this app already uses (Schedule, the
  Messages inbox/active-pane split) — not migrated live on resize; an
  accepted simplification, not a redesign mid-window.

  Polling: a single shared timer drives EVERY open desktop window plus
  the mobile overlay (if one is showing), gated only on "something is
  open" + tab visibility + logged in — deliberately NOT gated on
  messagesScreenActive like messages.js's own polling, since a DM window
  is supposed to keep working while the user is on Home/Teams/Film/etc.
  Still polling, not WebSockets/SSE, per the approved plan. A live
  message only marks a conversation read when the user is actually
  looking at it (an expanded, non-minimized window, or the one mobile
  conversation) — a minimized window instead accumulates a local unread
  count on its tab, and a 403 from any of this (the live server
  reevaluation from Phase 1) disables that window rather than silently
  retrying or pretending access still exists.
*/

/* ---------- New Message picker (unchanged from Phase 2) ---------- */

const newMessageBtn = document.querySelector("#new-message-btn");
const newMessageModal = document.querySelector("#new-message-modal");
const newMessageCloseBtn = document.querySelector("#new-message-close-btn");
const newMessageRecipientList = document.querySelector("#new-message-recipient-list");
const newMessageEmpty = document.querySelector("#new-message-empty");

function closeNewMessageModal() {
  newMessageModal?.classList.add("hidden");
}

function renderRecipientRow(recipient) {
  const li = document.createElement("li");
  li.className = "new-message-recipient-item";

  const nameEl = document.createElement("strong");
  nameEl.textContent = recipient.display_name;

  const contextEl = document.createElement("small");
  contextEl.textContent = recipient.context.join(" • ");

  li.appendChild(nameEl);
  li.appendChild(contextEl);

  li.addEventListener("click", () => {
    closeNewMessageModal();
    window.openDirectMessage(recipient.id, { displayName: recipient.display_name });
  });

  return li;
}

async function openNewMessageModal() {
  if (!newMessageModal) return;

  newMessageModal.classList.remove("hidden");
  newMessageEmpty.classList.add("hidden");
  newMessageRecipientList.innerHTML = "";
  const loadingLi = document.createElement("li");
  loadingLi.className = "messages-inbox-empty";
  loadingLi.textContent = "Loading…";
  newMessageRecipientList.appendChild(loadingLi);

  try {
    const recipients = await apiFetch("/api/messages/eligible-recipients");
    newMessageRecipientList.innerHTML = "";

    if (!recipients.length) {
      newMessageEmpty.classList.remove("hidden");
      return;
    }

    recipients.forEach((recipient) => newMessageRecipientList.appendChild(renderRecipientRow(recipient)));
  } catch (error) {
    console.error("Failed to load eligible recipients:", error);
    newMessageRecipientList.innerHTML = "";
    const errorLi = document.createElement("li");
    errorLi.className = "messages-inbox-empty";
    errorLi.textContent = "Could not load recipients.";
    newMessageRecipientList.appendChild(errorLi);
  }
}

newMessageBtn?.addEventListener("click", openNewMessageModal);
newMessageCloseBtn?.addEventListener("click", closeNewMessageModal);

/* ---------- shared helpers ---------- */

const DM_MOBILE_BREAKPOINT = "(max-width: 700px)";
const DM_POLL_INTERVAL_MS = 4000;
const MAX_EXPANDED_DM_WINDOWS = 3;
const DM_NEAR_BOTTOM_THRESHOLD_PX = 80;

const DM_ROLE_LABELS = {
  coach: "Coach",
  assistant_coach: "Assistant Coach",
  athlete: "Athlete",
  parent: "Parent",
};

function isMobileViewport() {
  return window.matchMedia(DM_MOBILE_BREAKPOINT).matches;
}

function dmOtherName(conversation) {
  return conversation.other_participant?.display_name || "Direct Message";
}

function dmOtherContext(conversation) {
  const role = conversation.other_participant?.role;
  return role ? DM_ROLE_LABELS[role] || role : "";
}

function isNearBottomEl(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < DM_NEAR_BOTTOM_THRESHOLD_PX;
}

// Team-vs-DM styling reasoning is the same as messages.js's own
// renderMessageRow (own/theirs, not coach/player — a 1:1 thread has no
// "coach side"); duplicated here rather than imported since it's small
// and each file owns its own rendering surface.
function renderDmMessageRow(message) {
  const row = document.createElement("div");
  const isMine = currentUser && Number(message.sender_id) === Number(currentUser.id);
  row.className = `message-row ${isMine ? "own-message" : "their-message"}`;

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

// Shared by desktop windows and the mobile overlay: append only
// not-yet-rendered messages (dedup by id) and preserve scroll position
// unless the caller forces a jump to bottom (opening/sending) or the
// user was already at the bottom. Returns how many rows were appended.
function appendMessagesToThread(threadEl, renderedIds, messages, forceScrollToBottom) {
  const wasNearBottom = forceScrollToBottom || isNearBottomEl(threadEl);
  let appended = 0;

  (Array.isArray(messages) ? messages : []).forEach((message) => {
    if (renderedIds.has(message.id)) return;
    renderedIds.add(message.id);
    threadEl.appendChild(renderDmMessageRow(message));
    appended += 1;
  });

  if (appended > 0 && wasNearBottom) {
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  return appended;
}

/* ---------- shared polling (drives every open window + the mobile overlay) ---------- */

let dmPollTimer = null;

function ensureDmPolling() {
  if (!dmPollTimer) {
    dmPollTimer = setInterval(pollAllOpenDirectMessages, DM_POLL_INTERVAL_MS);
  }
}

function stopDmPollingIfNothingOpen() {
  if (dmWindows.size === 0 && !mobileOverlayState.conversationId && dmPollTimer) {
    clearInterval(dmPollTimer);
    dmPollTimer = null;
  }
}

async function pollAllOpenDirectMessages() {
  if (document.visibilityState !== "visible" || !currentUser) return;

  for (const state of dmWindows.values()) {
    if (state.disabled) continue;
    // eslint-disable-next-line no-await-in-loop -- small N, sequential is fine and simpler than Promise.all error-handling here
    await loadWindowMessages(state, { scrollToBottom: false });
  }

  if (mobileOverlayState.conversationId && !mobileOverlayState.disabled) {
    await loadMobileMessages({ scrollToBottom: false });
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (dmWindows.size > 0 || mobileOverlayState.conversationId)) {
    pollAllOpenDirectMessages();
  }
});

window.addEventListener("focus", () => {
  if (dmWindows.size > 0 || mobileOverlayState.conversationId) {
    pollAllOpenDirectMessages();
  }
});

/* ---------- desktop floating windows ---------- */

const dmWindowsContainer = document.querySelector("#dm-windows-container");
const dmWindows = new Map(); // conversationId -> windowState

function createWindowElement(conversation) {
  const root = document.createElement("div");
  root.className = "dm-window";
  root.dataset.conversationId = String(conversation.id);

  const header = document.createElement("div");
  header.className = "dm-window-header";
  header.addEventListener("click", (event) => {
    if (event.target.closest(".dm-window-controls")) return;
    focusWindow(conversation.id);
  });

  const headerText = document.createElement("div");
  headerText.className = "dm-window-header-text";

  const titleEl = document.createElement("span");
  titleEl.className = "dm-window-title";
  titleEl.textContent = dmOtherName(conversation);

  const contextEl = document.createElement("span");
  contextEl.className = "dm-window-context";
  contextEl.textContent = dmOtherContext(conversation);

  headerText.appendChild(titleEl);
  headerText.appendChild(contextEl);

  const controls = document.createElement("div");
  controls.className = "dm-window-controls";

  const minimizeBtn = document.createElement("button");
  minimizeBtn.type = "button";
  minimizeBtn.setAttribute("aria-label", "Minimize");
  minimizeBtn.textContent = "–";
  minimizeBtn.addEventListener("click", () => minimizeWindow(conversation.id));

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => closeWindow(conversation.id));

  controls.appendChild(minimizeBtn);
  controls.appendChild(closeBtn);

  header.appendChild(headerText);
  header.appendChild(controls);

  const thread = document.createElement("div");
  thread.className = "dm-window-thread";

  const disabledBanner = document.createElement("p");
  disabledBanner.className = "dm-window-disabled-banner hidden";
  disabledBanner.textContent = "You can no longer access this conversation.";

  const form = document.createElement("form");
  form.className = "dm-window-form";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a message...";

  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.textContent = "Send";

  form.appendChild(input);
  form.appendChild(sendBtn);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendFromWindow(conversation.id);
  });

  root.appendChild(header);
  root.appendChild(thread);
  root.appendChild(disabledBanner);
  root.appendChild(form);

  return { root, titleEl, contextEl, thread, disabledBanner, input, sendBtn };
}

function createMinimizedTabElement(conversation) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "dm-minimized-tab hidden";
  tab.dataset.conversationId = String(conversation.id);
  tab.addEventListener("click", () => restoreWindow(conversation.id));

  const nameEl = document.createElement("span");
  nameEl.className = "dm-minimized-tab-name";
  nameEl.textContent = dmOtherName(conversation);

  const badgeEl = document.createElement("span");
  badgeEl.className = "dm-minimized-tab-badge hidden";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dm-minimized-tab-close-btn";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    closeWindow(conversation.id);
  });

  tab.appendChild(nameEl);
  tab.appendChild(badgeEl);
  tab.appendChild(closeBtn);

  return { tab, badgeEl };
}

function currentlyExpandedStates() {
  return Array.from(dmWindows.values()).filter((state) => !state.minimized);
}

// Keeps the visible window count "reasonable for the available
// viewport" (spec's own phrase) by minimizing the least-recently-focused
// expanded window whenever opening or restoring would exceed the cap --
// shared by createWindow() and restoreWindow() rather than duplicated.
function makeRoomForOneMoreExpandedWindow(excludingConversationId) {
  const expanded = currentlyExpandedStates().filter((state) => state.conversationId !== excludingConversationId);
  if (expanded.length < MAX_EXPANDED_DM_WINDOWS) return;

  const oldest = expanded.reduce((a, b) => (a.lastFocusedAt < b.lastFocusedAt ? a : b));
  minimizeWindow(oldest.conversationId);
}

function createWindow(conversation) {
  makeRoomForOneMoreExpandedWindow(conversation.id);

  const win = createWindowElement(conversation);
  const minTab = createMinimizedTabElement(conversation);

  const state = {
    conversationId: conversation.id,
    conversation,
    minimized: false,
    disabled: false,
    renderedMessageIds: new Set(),
    unreadWhileMinimized: 0,
    lastFocusedAt: Date.now(),
    win,
    minTab,
  };

  dmWindows.set(conversation.id, state);
  dmWindowsContainer.appendChild(win.root);
  dmWindowsContainer.appendChild(minTab.tab);

  ensureDmPolling();
  loadWindowMessages(state, { scrollToBottom: true, isOpenEvent: true });
  win.input.focus();
}

function focusWindow(conversationId) {
  const state = dmWindows.get(conversationId);
  if (!state) return;

  if (state.minimized) {
    restoreWindow(conversationId);
    return;
  }

  state.lastFocusedAt = Date.now();
  state.win.input.focus();
  state.win.root.classList.add("dm-window-focused");
  setTimeout(() => state.win.root.classList.remove("dm-window-focused"), 400);
}

function minimizeWindow(conversationId) {
  const state = dmWindows.get(conversationId);
  if (!state || state.minimized) return;

  state.minimized = true;
  state.win.root.classList.add("hidden");
  state.minTab.tab.classList.remove("hidden");
}

function restoreWindow(conversationId) {
  const state = dmWindows.get(conversationId);
  if (!state || !state.minimized) return;

  makeRoomForOneMoreExpandedWindow(conversationId);

  state.minimized = false;
  state.unreadWhileMinimized = 0;
  state.lastFocusedAt = Date.now();
  state.win.root.classList.remove("hidden");
  state.minTab.tab.classList.add("hidden");
  renderMinimizedBadge(state);
  state.win.input.focus();

  // Restoring IS the user actually viewing it — catch up on anything
  // that arrived while minimized and mark the thread read now.
  loadWindowMessages(state, { scrollToBottom: true, isOpenEvent: true });
}

function closeWindow(conversationId) {
  const state = dmWindows.get(conversationId);
  if (!state) return;

  state.win.root.remove();
  state.minTab.tab.remove();
  dmWindows.delete(conversationId);
  stopDmPollingIfNothingOpen();
}

function renderMinimizedBadge(state) {
  const badge = state.minTab.badgeEl;
  if (state.unreadWhileMinimized > 0) {
    badge.textContent = state.unreadWhileMinimized > 9 ? "9+" : String(state.unreadWhileMinimized);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function disableWindow(state) {
  state.disabled = true;
  state.win.disabledBanner.classList.remove("hidden");
  state.win.input.disabled = true;
  state.win.sendBtn.disabled = true;
  state.win.root.classList.add("dm-window-disabled");
}

async function loadWindowMessages(state, { scrollToBottom = false, isOpenEvent = false } = {}) {
  if (state.disabled) return;

  try {
    const messages = await apiFetch(`/api/conversations/${state.conversationId}/messages`);
    const appended = appendMessagesToThread(state.win.thread, state.renderedMessageIds, messages, scrollToBottom);

    if (!state.minimized) {
      if (appended > 0 || isOpenEvent) {
        await markConversationRead(state.conversationId);
      }
    } else if (appended > 0) {
      state.unreadWhileMinimized += appended;
      renderMinimizedBadge(state);
    }
  } catch (error) {
    if (error?.status === 403) {
      disableWindow(state);
      return;
    }
    console.error("DM window load/poll failed:", error);
  }
}

async function sendFromWindow(conversationId) {
  const state = dmWindows.get(conversationId);
  if (!state || state.disabled) return;

  const body = state.win.input.value.trim();
  if (!body) return;

  state.win.sendBtn.disabled = true;
  try {
    await apiFetch(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    state.win.input.value = "";
    await loadWindowMessages(state, { scrollToBottom: true, isOpenEvent: true });
  } catch (error) {
    if (error?.status === 403) {
      disableWindow(state);
    } else {
      console.error("Failed to send DM:", error);
      showMessage("Could not send message. Please try again.");
    }
  } finally {
    if (!state.disabled) state.win.sendBtn.disabled = false;
  }
}

async function markConversationRead(conversationId) {
  try {
    await apiFetch(`/api/conversations/${conversationId}/read`, { method: "PUT" });
    if (typeof window.refreshMessagesConversations === "function") {
      await window.refreshMessagesConversations();
    }
  } catch (error) {
    console.error("Failed to mark direct message read:", error);
  }
}

/* ---------- mobile full-screen overlay ---------- */

const dmMobileOverlay = document.querySelector("#dm-mobile-overlay");
const dmMobileBackBtn = document.querySelector("#dm-mobile-back-btn");
const dmMobileTitle = document.querySelector("#dm-mobile-title");
const dmMobileContext = document.querySelector("#dm-mobile-context");
const dmMobileThread = document.querySelector("#dm-mobile-thread");
const dmMobileDisabledBanner = document.querySelector("#dm-mobile-disabled-banner");
const dmMobileForm = document.querySelector("#dm-mobile-form");
const dmMobileInput = document.querySelector("#dm-mobile-input");
const dmMobileSendBtn = dmMobileForm?.querySelector('button[type="submit"]');

let mobileOverlayState = { conversationId: null, conversation: null, renderedMessageIds: new Set(), disabled: false };

function openMobileDm(conversation) {
  mobileOverlayState = {
    conversationId: conversation.id,
    conversation,
    renderedMessageIds: new Set(),
    disabled: false,
  };

  dmMobileTitle.textContent = dmOtherName(conversation);
  dmMobileContext.textContent = dmOtherContext(conversation);
  dmMobileThread.innerHTML = "";
  dmMobileDisabledBanner.classList.add("hidden");
  dmMobileInput.disabled = false;
  dmMobileSendBtn.disabled = false;
  dmMobileOverlay.classList.remove("hidden");

  ensureDmPolling();
  loadMobileMessages({ scrollToBottom: true, isOpenEvent: true });
}

// A pure overlay on top of whatever screen was already active — closing
// it just hides the overlay, which trivially "returns the user to
// exactly where they were" since the underlying .app-screen was never
// left in the first place.
function closeMobileDm() {
  dmMobileOverlay.classList.add("hidden");
  mobileOverlayState = { conversationId: null, conversation: null, renderedMessageIds: new Set(), disabled: false };
  stopDmPollingIfNothingOpen();
}

dmMobileBackBtn?.addEventListener("click", closeMobileDm);

async function loadMobileMessages({ scrollToBottom = false, isOpenEvent = false } = {}) {
  if (!mobileOverlayState.conversationId || mobileOverlayState.disabled) return;

  try {
    const messages = await apiFetch(`/api/conversations/${mobileOverlayState.conversationId}/messages`);
    const appended = appendMessagesToThread(
      dmMobileThread,
      mobileOverlayState.renderedMessageIds,
      messages,
      scrollToBottom
    );

    if (appended > 0 || isOpenEvent) {
      await markConversationRead(mobileOverlayState.conversationId);
    }
  } catch (error) {
    if (error?.status === 403) {
      mobileOverlayState.disabled = true;
      dmMobileDisabledBanner.classList.remove("hidden");
      dmMobileInput.disabled = true;
      dmMobileSendBtn.disabled = true;
      return;
    }
    console.error("Mobile DM load/poll failed:", error);
  }
}

dmMobileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!mobileOverlayState.conversationId || mobileOverlayState.disabled) return;

  const body = dmMobileInput.value.trim();
  if (!body) return;

  dmMobileSendBtn.disabled = true;
  try {
    await apiFetch(`/api/conversations/${mobileOverlayState.conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    dmMobileInput.value = "";
    await loadMobileMessages({ scrollToBottom: true, isOpenEvent: true });
  } catch (error) {
    console.error("Failed to send mobile DM:", error);
    showMessage("Could not send message. Please try again.");
  } finally {
    if (!mobileOverlayState.disabled) dmMobileSendBtn.disabled = false;
  }
});

/* ---------- the shared "open or focus" entry point ---------- */

// Called by messages.js's window.selectMessagesConversation() for any
// category='direct' conversation — both an inbox row click and
// openDirectMessage() funnel through that one function, so this is the
// single place that decides desktop-window vs. mobile-overlay and
// open-vs-focus. Opening an already-open conversation always
// focuses/restores the existing window or re-shows the existing mobile
// overlay — it never creates a second one for the same canonical
// conversation id.
window.openDirectMessageWindow = function (conversation) {
  if (!conversation || conversation.category !== "direct") return;

  if (isMobileViewport()) {
    openMobileDm(conversation);
    return;
  }

  if (dmWindows.has(conversation.id)) {
    focusWindow(conversation.id);
    return;
  }

  createWindow(conversation);
};

// The reusable Direct Message entry point (Phase 2, unchanged
// signature) — Roster Profiles will call this from a future Profile
// "Message" button. `context` is an optional display hint a caller may
// already have; the real conversation/participant data always comes
// from the server. Deliberately does NOT navigate screens anymore (it
// did in Phase 2, before floating windows existed) — a DM now opens on
// top of whatever screen the user is already on, which is the entire
// point of using floating windows instead of a full-screen destination.
// Never trust a client-supplied userId as proof of eligibility — POST
// /api/direct-messages re-derives that server-side regardless.
window.openDirectMessage = async function (userId, context = {}) {
  if (!currentUser || !userId) return;

  try {
    const conversation = await apiFetch("/api/direct-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_user_id: userId }),
    });

    if (typeof window.selectMessagesConversation === "function") {
      await window.selectMessagesConversation(conversation.id);
    }
  } catch (error) {
    console.error("Failed to open direct message:", error);
    showMessage(error.message || "Could not open this conversation.");
  }
};

/* ---------- lifecycle: clear everything on login/logout ---------- */

function closeAllDirectMessageWindows() {
  dmWindows.forEach((state) => {
    state.win.root.remove();
    state.minTab.tab.remove();
  });
  dmWindows.clear();
  closeMobileDm();
}

const __originalActivateAppForDirectMessages = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForDirectMessages(user);
  // A fresh login should never inherit floating windows from whichever
  // account was previously signed in on this device.
  closeAllDirectMessageWindows();
};

const __originalLogoutLocalStateForDirectMessages = window.logoutLocalState;
window.logoutLocalState = function () {
  closeAllDirectMessageWindows(); // clears dmWindows/mobileOverlayState first...
  stopDmPollingIfNothingOpen(); // ...so this always actually stops the timer
  __originalLogoutLocalStateForDirectMessages();
};
