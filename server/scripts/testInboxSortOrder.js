/*
  testInboxSortOrder.js — regression test for the Messages inbox sort fix
  (fix/direct-messaging-followup): unread conversations above read ones,
  newest-activity-first within each group.

  Like testInitialUnreadBadge.js, this is not an HTTP acceptance test --
  the sort itself is pure client-side rendering logic (no DOM/browser
  harness exists in this project; see CLAUDE.md's stack conventions).
  Rather than reimplement the comparator by hand (which could silently
  drift from the real shipped code), this extracts
  compareConversationsForInbox() verbatim out of client/messages.js and
  actually EXECUTES it against synthetic conversation objects -- so this
  test fails if the real function's behavior ever changes, not just if
  its source text changes.

  Run: node server/scripts/testInboxSortOrder.js (no server, no DB).
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MESSAGES_JS_PATH = path.join(__dirname, "../../client/messages.js");
const source = fs.readFileSync(MESSAGES_JS_PATH, "utf8");

const results = [];
function assert(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

// Extract exactly the one function -- from its own declaration to the
// closing brace immediately before renderInboxRow's declaration, which
// is guaranteed adjacent (see messages.js). If this marker ever moves,
// this test fails loudly (extractedSource === null) rather than silently
// testing stale/wrong code.
function extractFunction(src, name, nextMarker) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const end = src.indexOf(nextMarker, start);
  if (end === -1) return null;
  return src.slice(start, end);
}

const extracted = extractFunction(source, "compareConversationsForInbox", "function renderInboxRow(");
assert("compareConversationsForInbox() found and extracted from client/messages.js", Boolean(extracted));

if (!extracted) {
  console.log("\nCannot run sort assertions -- extraction failed.");
  process.exitCode = 1;
  return;
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${extracted}\nthis.compareConversationsForInbox = compareConversationsForInbox;`, sandbox);
const compare = sandbox.compareConversationsForInbox;

function sortedIds(conversations) {
  return [...conversations].sort(compare).map((c) => c.id);
}

function conv(id, { unread = 0, at } = {}) {
  return { id, unread_count: unread, last_message_at: at };
}

// ---- A. unread Team Chat above newer read conversations ----
// (the comparator itself is category-agnostic -- it's applied
// independently to the Team Chats array and the Direct Messages array in
// renderInbox(), so testing it generically here covers both call sites.)
{
  const older = conv("teamchat-unread-older", { unread: 3, at: "2026-01-01T00:00:00Z" });
  const newer = conv("teamchat-read-newer", { unread: 0, at: "2026-06-01T00:00:00Z" });
  const order = sortedIds([newer, older]);
  assert(
    "A. an unread conversation ranks above a read conversation with newer activity",
    order[0] === "teamchat-unread-older",
    `order=${order.join(",")}`
  );
}

// ---- B. unread DM above newer read conversation (same comparator, different data) ----
{
  const unreadDm = conv("dm-unread", { unread: 1, at: "2026-02-01T00:00:00Z" });
  const readDmNewer = conv("dm-read-newer", { unread: 0, at: "2026-07-01T00:00:00Z" });
  const order = sortedIds([readDmNewer, unreadDm]);
  assert("B. unread DM ranks above a newer read DM", order[0] === "dm-unread", `order=${order.join(",")}`);
}

// ---- C. multiple unread threads ordered by latest activity ----
{
  const a = conv("unread-oldest", { unread: 1, at: "2026-01-01T00:00:00Z" });
  const b = conv("unread-newest", { unread: 5, at: "2026-03-01T00:00:00Z" });
  const c = conv("unread-middle", { unread: 2, at: "2026-02-01T00:00:00Z" });
  const order = sortedIds([a, b, c]);
  assert(
    "C. multiple unread threads sort newest-activity-first among themselves",
    order.join(",") === "unread-newest,unread-middle,unread-oldest",
    `order=${order.join(",")}`
  );
}

// ---- D. read conversations also sort newest-first among themselves ----
{
  const a = conv("read-oldest", { unread: 0, at: "2026-01-01T00:00:00Z" });
  const b = conv("read-newest", { unread: 0, at: "2026-05-01T00:00:00Z" });
  const order = sortedIds([a, b]);
  assert("D. read conversations sort newest-first among themselves", order.join(",") === "read-newest,read-oldest", `order=${order.join(",")}`);
}

// ---- E. a conversation with no messages yet (last_message_at null) sorts last within its group ----
{
  const withActivity = conv("has-activity", { unread: 0, at: "2026-01-01T00:00:00Z" });
  const empty = conv("no-activity-yet", { unread: 0, at: null });
  const order = sortedIds([empty, withActivity]);
  assert("E. a conversation with no last_message_at sorts after one with real activity", order.join(",") === "has-activity,no-activity-yet", `order=${order.join(",")}`);
}

// ---- F. "reading a thread clears its badge and re-sorts correctly" --
// modeled as: the exact same conversation object, before/after its
// unread_count is zeroed (which is literally what
// window.markCurrentConversationRead does locally -- see messages.js --
// before the next renderInbox() call), moves from the unread group to
// its correct chronological position in the read group.
{
  const target = conv("target", { unread: 4, at: "2026-01-01T00:00:00Z" }); // old, but unread
  const newerRead = conv("newer-read", { unread: 0, at: "2026-06-01T00:00:00Z" });
  const olderRead = conv("older-read", { unread: 0, at: "2026-02-01T00:00:00Z" });

  const beforeRead = sortedIds([target, newerRead, olderRead]);
  assert("F1. before being read, the unread target ranks first despite being oldest", beforeRead[0] === "target", `order=${beforeRead.join(",")}`);

  target.unread_count = 0; // exactly what markCurrentConversationRead does locally
  const afterRead = sortedIds([target, newerRead, olderRead]);
  assert(
    "F2. after being marked read, the same conversation re-sorts into its chronological position among read threads",
    afterRead.join(",") === "newer-read,older-read,target",
    `order=${afterRead.join(",")}`
  );
}

// ---- G. sort is stable for equal keys (doesn't shuffle ties) ----
{
  const a = conv("tie-a", { unread: 0, at: "2026-01-01T00:00:00Z" });
  const b = conv("tie-b", { unread: 0, at: "2026-01-01T00:00:00Z" });
  const order = sortedIds([a, b]);
  assert("G. equal-key conversations keep their original relative order (stable sort)", order.join(",") === "tie-a,tie-b", `order=${order.join(",")}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("Failures:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
