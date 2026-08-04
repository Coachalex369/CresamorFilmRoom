require("dotenv").config();

const app = require("./app");
const client = require("./db/client");
// eslint-disable-next-line no-unused-vars -- kept available for when
// boot-time requeue is safely re-enabled, see the incident note below.
const { requeueStuckConversions } = require("./services/videoProcessing");

const PORT = process.env.PORT || 3000;

// Production incident (Beta Stabilization Sprint follow-up): server.js
// used to gate app.listen() behind an async DB check AND the boot-time
// conversion requeue, inside one try/catch that only logged on failure
// and never called listen() at all if either step threw or hung — a
// silent failure mode where the process stays alive but never serves a
// single request, indistinguishable from a full outage to Render's proxy
// (502 on everything, including static assets and /api/health, which
// doesn't even touch the DB). Listening now happens first and
// unconditionally; DB connectivity and the conversion requeue are
// separate, non-blocking background steps that can fail without ever
// taking the HTTP server down with them.
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
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

// TEMPORARILY DISABLED — production incident: this re-queued a video
// still marked 'converting' from a prior process life and immediately
// started a real, resource-intensive ffmpeg conversion at startup on a
// ~685MB file, starving the 0.5 vCPU/512MB instance of CPU/RAM before
// Express could serve health checks — Render reported sustained 502s
// across every route, static assets included. Do not re-enable until the
// requeue logic is made safe (e.g., skip anything that previously caused
// a failure, or apply the same size-based deferral the upload route
// already does for new uploads, rather than blindly retrying whatever
// was in flight regardless of why).
// requeueStuckConversions().catch((err) => console.error("Boot-time conversion requeue failed:", err));