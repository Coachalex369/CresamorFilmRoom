/*
  requireProductionTestOptIn.js — safety gate for every script under
  server/scripts/ that creates, modifies, or deletes real rows through
  DATABASE_URL. This project has one shared dev/prod database — there is
  no separate local database (see CLAUDE.md's "Known architectural
  quirks") — so any script run locally is, by default, writing to the
  same database production uses.

  Added after an incident where test/recovery code ran against production
  more than once without anyone deliberately choosing that outcome. This
  is a second, independent layer on top of any in-app environment guard
  (e.g. videoProcessing.js's isRecoveryEnvironmentSafe()) — it protects
  against running the WRONG SCRIPT, not just the wrong environment
  variable combination.

  Every script that writes to the DB must call this as its first
  executable statement, before connecting or querying anything.
*/
function requireProductionTestOptIn(scriptName) {
  if (process.env.ALLOW_PRODUCTION_TESTS === "true") return;

  console.error(
    "\n" +
      "!".repeat(70) +
      `\nREFUSING TO RUN: ${scriptName}\n` +
      "This script creates, modifies, or deletes rows in the database " +
      "configured by DATABASE_URL. In this project that is the SAME " +
      "database production uses — there is no separate local database.\n" +
      "Set ALLOW_PRODUCTION_TESTS=true in the environment to run it " +
      "deliberately (shell syntax for that varies — bash: " +
      "`ALLOW_PRODUCTION_TESTS=true node ...`; PowerShell: " +
      "`$env:ALLOW_PRODUCTION_TESTS=\"true\"` first).\n" +
      "!".repeat(70) +
      "\n"
  );
  process.exit(1);
}

module.exports = { requireProductionTestOptIn };
