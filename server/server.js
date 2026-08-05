require("dotenv").config();

const app = require("./app");
const client = require("./db/client");
const { recoverStrandedConversions } = require("./services/videoProcessing");

const PORT = process.env.PORT || 3000;

// Production incident (Beta Stabilization Sprint follow-up): server.js
// used to gate app.listen() behind an async DB check AND the boot-time
// conversion requeue, inside one try/catch that only logged on failure
// and never called listen() at all if either step threw or hung — a
// silent failure mode where the process stays alive but never serves a
// single request, indistinguishable from a full outage to Render's proxy
// (502 on everything, including static assets and /api/health, which
// doesn't even touch the DB). Listening now happens first and
// unconditionally; DB connectivity is a separate, non-blocking background
// step that can fail without ever taking the HTTP server down with it.
//
// Conversion recovery redesign: the original boot-time requeue (which
// caused the incident above by blindly re-attempting a large file's
// conversion at startup) was disabled rather than fixed for a while.
// recoverStrandedConversions() is the safe replacement — re-checks each
// stranded video's size before resuming it, single-flight, self-contained
// error handling — and it's called from INSIDE this success callback
// specifically so there's a structural guarantee it can only ever run
// after the server is already accepting requests, never before or
// instead of that.
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  recoverStrandedConversions().catch((error) => {
    console.error("Startup conversion recovery failed:", error);
  });
});

server.on("close", () => {
  console.log("HTTP server closed");
});

server.on("error", (err) => {
  console.error("HTTP server error:", err);
});

process.on("exit", (code) => {
  console.log("Process exiting with code:", code);
});

process.on("beforeExit", (code) => {
  console.log("Process beforeExit code:", code);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

client
  .query("SELECT 1")
  .then(() => console.log("Connected to PostgreSQL"))
  .catch((err) => console.error("Database connectivity check failed:", err));