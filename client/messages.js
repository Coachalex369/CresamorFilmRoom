/*
  messages.js — real, conversation-scoped persistence for Team Messages.

  Foundation Sprint Phase 2: previously (Sprint 3) this called the flat
  GET/POST /api/messages endpoints. Those are now retired — the backend is
  built around Conversations -> Conversation Participants -> Messages (see
  CLAUDE.md). The MVP UI still only ever shows one thread, so this file
  fetches the current user's conversations and uses the first one — but the
  underlying calls are genuinely conversation-scoped and permission-checked
  server-side now (a user who isn't a participant gets a real 403, not just
  "the UI doesn't show a picker").

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

const realMessageUsernameInput = realMessageForm?.querySelector("#message-username-input");
const realMessageRoleInput = realMessageForm?.querySelector("#message-role-input");
const realMessageBodyInput = realMessageForm?.querySelector("#message-input");

let currentConversationId = null;

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

async function ensureCurrentConversation() {
  if (currentConversationId || !currentUser) return currentConversationId;

  try {
    const conversations = await apiFetch(`/api/conversations?user_id=${currentUser.id}`);
    currentConversationId = conversations?.[0]?.id || null;
  } catch (error) {
    console.error("Failed to load conversations:", error);
  }

  return currentConversationId;
}

async function loadMessages() {
  if (!realMessageThread) return;

  const conversationId = await ensureCurrentConversation();
  if (!conversationId || !currentUser) return;

  try {
    const messages = await apiFetch(
      `/api/conversations/${conversationId}/messages?user_id=${currentUser.id}`
    );

    realMessageThread.innerHTML = "";
    (Array.isArray(messages) ? messages : []).forEach((message) => {
      realMessageThread.appendChild(renderMessageRow(message));
    });

    realMessageThread.scrollTop = realMessageThread.scrollHeight;

    // Home's preview reads #message-thread directly — refresh it now that
    // real data has landed (safe no-op if home.js hasn't rendered yet).
    if (typeof window.renderMessagesPreview === "function") {
      window.renderMessagesPreview();
    }
  } catch (error) {
    console.error("Failed to load messages:", error);
  }
}

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUser.id }),
    });
  } catch (error) {
    console.error("Failed to mark conversation read:", error);
  }
};

if (realMessageForm) {
  realMessageForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const body = realMessageBodyInput.value.trim();
    const username = realMessageUsernameInput.value.trim() || "User";
    const role = realMessageRoleInput.value;

    if (!body) return;

    const conversationId = await ensureCurrentConversation();

    if (!conversationId) {
      showMessage("No conversation available yet.");
      return;
    }

    try {
      await apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender_id: currentUser ? currentUser.id : null,
          username,
          role,
          body,
        }),
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
  currentConversationId = null; // reset on login so a different user re-resolves their own conversation
  loadMessages();
};

if (currentUser) {
  loadMessages();
}
