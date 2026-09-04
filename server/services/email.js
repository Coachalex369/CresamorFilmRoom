/*
  email.js — Teams MVP. Sends invitation and password-reset emails.

  Env-gated, same "swappable provider, safe default when unconfigured"
  shape as storage/storage.js's STORAGE_PROVIDER pattern: if SMTP_HOST
  isn't set, sendEmail() logs and resolves { sent: false } instead of
  throwing, so local dev and a not-yet-configured production instance
  both work without real credentials. This is also why "copy or share an
  invitation link manually" is a required capability everywhere email is
  used — the raw link is always available regardless of whether this
  actually sends anything.

  Never logs the full email body (it contains a live invitation/reset
  link, which is a bearer credential) — only the recipient and subject.

  Resend integration: this project never actually had a real SMTP
  provider configured before (SMTP_HOST was never set anywhere,
  confirmed empty in both local .env and, per the project owner,
  Render) — Resend is the first real send path. Uses Resend's own SMTP
  relay (smtp.resend.com) rather than their REST API/SDK specifically
  so this file needed zero structural change — same nodemailer
  transport, same env-var-driven "safe when unconfigured" shape, just
  pointed at a real provider. See ARCHITECTURE.md for the exact Render
  env vars and the one-time Resend dashboard setup (domain
  verification, receiving, click/open tracking — none of which are
  reachable from a sending-only API key, same "dashboard-only lever"
  situation as R2 bucket CORS).
*/

const nodemailer = require("nodemailer");

// Fixed sending identity for every transactional email this project
// sends — not per-call-site configurable, since "reply goes to a real
// human inbox, from address is the one verified domain" is a blanket
// policy, not a per-message choice. Env-overridable only so a future
// provider/address change doesn't require a code deploy.
const DEFAULT_FROM_ADDRESS = "Cresamor <notifications@updates.cresamor.com>";
const DEFAULT_REPLY_TO = "support@cresamor.com";

let transporter = null;
let attemptedInit = false;

function getTransporter() {
  if (attemptedInit) return transporter;
  attemptedInit = true;

  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  return transporter;
}

// Best-effort — never throws. Callers (invitations.js, auth.js) treat a
// failed/unconfigured send as a non-fatal condition, since the raw link
// this email would have contained is always shown/returned to the caller
// through some other channel too (manual copy, SMS, the API response).
async function sendEmail({ to, subject, html, text }) {
  const transport = getTransporter();

  if (!transport) {
    console.warn(`Email not sent (SMTP not configured) — to=${to} subject="${subject}"`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS,
      replyTo: process.env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
      to,
      subject,
      html,
      text,
    });
    return { sent: true };
  } catch (error) {
    console.error(`Failed to send email to=${to} subject="${subject}":`, error.message);
    return { sent: false, reason: "send_failed" };
  }
}

module.exports = { sendEmail };
