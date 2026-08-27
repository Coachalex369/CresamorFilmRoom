/*
  testInitialUnreadBadge.js — regression guard for the fresh-login/cold-
  restore unread-badge delay fix (fix/direct-messaging-initial-unread).

  The bug this guards against: window.activateApp's messages.js wrapper
  and the cold-restore block both called refreshPollingState() with no
  arguments -- that starts the poll TIMER right away, but the first real
  pollConversationList() call still waited a full
  CONVERSATION_LIST_POLL_INTERVAL_MS (12s), so an already-existing unread
  DM/Team Chat message left the nav badge at 0/hidden for up to that long
  after a fresh login, until the timer's first tick fired or the user
  clicked a tab/refocused the window (both of those call sites already
  passed { immediate: true } and were never the problem).

  This is a plain source-content check, not an HTTP acceptance test --
  there is no browser/DOM test harness in this project (no bundler, no
  test framework; see CLAUDE.md's stack conventions), and the actual bug
  is client-side JS scheduling, not anything the server returns wrong
  (GET /api/conversations was always correct the instant it was called --
  confirmed manually in-browser, see this fix's commit message). A static
  check on the exact two call sites plus the safety invariants the fix
  depends on (idempotent timers, busy-guarded polls -- so making the
  first refresh immediate can never create a duplicate timer or an
  overlapping duplicate network call) is what's actually verifiable
  without inventing new test infrastructure for one fix.

  Run: node server/scripts/testInitialUnreadBadge.js (no server, no DB,
  no ALLOW_PRODUCTION_TESTS needed -- reads only client/messages.js).
*/

const fs = require("fs");
const path = require("path");

const MESSAGES_JS_PATH = path.join(__dirname, "../../client/messages.js");
const source = fs.readFileSync(MESSAGES_JS_PATH, "utf8");

const results = [];
function assert(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

// 1. The fresh-login call site: window.activateApp's messages.js wrapper.
assert(
  "window.activateApp's messages.js wrapper calls refreshPollingState({ immediate: true })",
  /messagesInboxState = \{ conversations: \[\], selectedConversationId: null, selectedConversation: null \};\s*(?:\/\/[^\n]*\n\s*)*refreshPollingState\(\s*\{\s*immediate:\s*true\s*\}\s*\)/.test(
    source
  )
);

// 2. The cold-restore (page-load-with-existing-token) call site.
assert(
  "cold-restore block calls refreshPollingState({ immediate: true })",
  /if \(currentUser\) \{\s*initMessagesScreen\(\);\s*refreshPollingState\(\s*\{\s*immediate:\s*true\s*\}\s*\)/.test(
    source
  )
);

// 3. Every other refreshPollingState call site must ALSO still pass
// immediate: true (tab click, visibilitychange-visible, focus) -- this
// fix must not have narrowed those, and none of them should have
// regressed to omitting it either.
const allImmediateTrueCalls = (source.match(/refreshPollingState\(\s*\{\s*immediate:\s*true\s*\}\s*\)/g) || []).length;
const allBareCalls = (source.match(/refreshPollingState\(\s*\)/g) || []).length;
assert(
  "every refreshPollingState() call site in messages.js passes immediate: true (none left bare)",
  allBareCalls === 0 && allImmediateTrueCalls >= 4,
  `bareCalls=${allBareCalls} immediateTrueCalls=${allImmediateTrueCalls}`
);

// 4. Safety invariant this fix leans on: making the first refresh
// immediate must never be able to create a SECOND timer -- both start*
// functions must still guard on "only start if not already running".
assert(
  "startActiveThreadPolling() still guards against creating a duplicate timer",
  /function startActiveThreadPolling\(\)\s*\{\s*if \(!messagePollTimer\)/.test(source)
);
assert(
  "startConversationListPolling() still guards against creating a duplicate timer",
  /function startConversationListPolling\(\)\s*\{\s*if \(!conversationListPollTimer\)/.test(source)
);

// 5. Safety invariant: an immediate call landing while a poll is already
// in flight (e.g. login racing a near-simultaneous tab click) must not
// fire a duplicate overlapping network request -- both poll functions
// must still busy-guard themselves.
assert(
  "pollConversationList() still busy-guards against an overlapping duplicate call",
  /async function pollConversationList\(\)\s*\{\s*if \(conversationListPollBusy\) return;/.test(source)
);
assert(
  "pollActiveConversation() still busy-guards against an overlapping duplicate call",
  /async function pollActiveConversation\(\)\s*\{\s*if \(messagePollBusy\) return;/.test(source)
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("Failures:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
