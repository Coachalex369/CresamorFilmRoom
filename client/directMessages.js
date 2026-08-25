/*
  directMessages.js — Direct Messaging Phase 2: the "New Message"
  recipient picker, and the reusable window.openDirectMessage() entry
  point. This is the ONE function Roster Profiles (the next feature
  branch) will call from a future Profile "Message" button — see the
  approved plan's section 9 ("Profile -> Message -> existing/new
  canonical DM window"). Nothing about its calling contract
  (openDirectMessage(userId, context)) should need to change in Phase 3;
  only what happens INSIDE it (today: select the conversation in the
  inline active pane; Phase 3: open/focus a floating AIM-style window
  instead) will.

  Deliberately thin: recipient eligibility is entirely server-enforced
  (GET /api/messages/eligible-recipients, see Phase 1's
  getEligibleRecipients) — this file never decides who's messageable, it
  only renders whatever the server already filtered down to. Never shows
  or has access to email/phone.

  Loaded after messages.js (needs window.selectMessagesConversation) and
  last in script load order — nothing else depends on this file yet.
*/

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

// Reusable Direct Message entry point. `context` is an optional display
// hint a caller may already know (e.g. Roster Profiles might pass the
// athlete's name it already has on screen) — used nowhere yet in Phase
// 2 beyond accepting the shape, since the real conversation/participant
// data always comes from the server, never the caller. Never trust a
// client-supplied userId as proof of eligibility — POST
// /api/direct-messages re-derives that server-side (Phase 1's
// canInitiateDirectMessage) regardless of what this function passes.
window.openDirectMessage = async function (userId, context = {}) {
  if (!currentUser || !userId) return;

  switchToScreen("messages-screen");

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
