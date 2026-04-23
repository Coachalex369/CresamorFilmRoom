require("dotenv").config();

const app = require("./app");
const client = require("./db/client");

const PORT = process.env.PORT || 3000;

let server;

async function startServer() {
  try {
    await client.query("SELECT 1");
    console.log("Connected to PostgreSQL");

    server = app.listen(PORT, () => {
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
  } catch (err) {
    console.error("Failed to start server:", err);
  }
}

startServer();