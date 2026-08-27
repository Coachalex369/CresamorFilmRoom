/*
  backfillMessageSenderLabels.js — one-time, manual, never auto-run data
  repair for messages.username values that still contain a real email
  address (the historical write-path bug fixed in
  server/services/messageLabels.js / server/routes/conversations.js).

  Transaction-safe: every UPDATE runs inside one BEGIN/COMMIT, ROLLBACK on
  any failure -- either every affected row is fixed or none are. Only
  touches the `username` column; message content, sender_id, timestamps,
  conversation_id, and every conversation_participants/read-state row are
  completely untouched.

  Never logs, prints, or hard-codes an actual email address anywhere --
  only row ids, sender ids, and the computed replacement label. The
  affected rows are found with a pattern match, not a literal address.

  Run by hand, always dry-run first:
    node server/scripts/backfillMessageSenderLabels.js --dry-run
    node server/scripts/backfillMessageSenderLabels.js
*/

require("dotenv").config();

const client = require("../db/client");
const { safeSenderLabel } = require("../services/messageLabels");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const conn = await client.connect();

  try {
    await conn.query("BEGIN");

    // Pattern match only -- never references a real address. JOINs to
    // the sender's CURRENT display_name/role so the replacement is the
    // exact same label safeSenderLabel() would compute for that user
    // today, not a guess.
    const affected = await conn.query(
      `
      SELECT m.id, m.sender_id, u.display_name, u.role
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.username ~ '^\\S+@\\S+\\.\\S+$'
      ORDER BY m.id
      `
    );

    console.log(`Found ${affected.rows.length} message row(s) with an email-valued username.`);

    for (const row of affected.rows) {
      const replacement = safeSenderLabel({ display_name: row.display_name, role: row.role });

      if (!dryRun) {
        await conn.query("UPDATE messages SET username = $1 WHERE id = $2", [replacement, row.id]);
      }

      console.log(
        `  message id=${row.id} sender_id=${row.sender_id} -> "${replacement}"${dryRun ? " (dry run, not applied)" : ""}`
      );
    }

    if (dryRun) {
      await conn.query("ROLLBACK");
      console.log("Dry run complete -- rolled back, nothing changed.");
    } else {
      await conn.query("COMMIT");
      console.log(`Backfill complete -- ${affected.rows.length} row(s) updated.`);
    }
  } catch (error) {
    await conn.query("ROLLBACK");
    console.error("Backfill failed, rolled back:", error);
    process.exitCode = 1;
  } finally {
    conn.release();
    await client.end();
  }
}

main();
