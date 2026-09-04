/*
  email.js — Teams MVP. Sends invitation and password-reset emails.

  Env-gated, same "swappable provider, safe default when unconfigured"
  shape as storage/storage.js's STORAGE_PROVIDER pattern: if no API key
  is configured, sendEmail() logs and resolves { sent: false } instead
  of throwing, so local dev and a not-yet-configured production
  instance both work without real credentials. This is also why "copy
  or share an invitation link manually" is a required capability
  everywhere email is used — the raw link is always available
  regardless of whether this actually sends anything.

  Never logs the full email body, an invitation token, or a
  password-reset token (all bearer credentials) — only the recipient,
  subject, and (on failure) a short provider-supplied error string.

  Transport history: originally generic SMTP (nodemailer) pointed at
  Resend's SMTP relay. Switched to Resend's HTTPS API (2026-09-04)
  after two live production sends both hung for roughly a minute before
  failing — the signature of Render's outbound network not being able
  to reach Resend's SMTP relay at all (a connection-level block, not a
  credentials problem; a bad password fails fast, right after TLS,
  during AUTH — it doesn't hang). Confirmed correct port from Resend's
  own docs (2465, implicit TLS) didn't change the outcome, which is
  consistent with the network path itself being blocked rather than
  another port typo. HTTPS on 443 sidesteps this entirely — it's the
  same protocol/port every other API call in this app already uses
  successfully. SMTP_HOST/PORT/SECURE/USER are now unused by this file
  (legacy — harmless to leave set in Render, see ARCHITECTURE.md);
  SMTP_PASS is still read, but only as a fallback source for the API
  key so the secret already stored in Render doesn't need re-entry.
*/

const RESEND_API_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10000;

// Fixed sending identity for every transactional email this project
// sends — not per-call-site configurable, since "reply goes to a real
// human inbox, from address is the one verified domain" is a blanket
// policy, not a per-message choice. Env-overridable only so a future
// provider/address change doesn't require a code deploy.
const DEFAULT_FROM_ADDRESS = "Cresamor <notifications@updates.cresamor.com>";
const DEFAULT_REPLY_TO = "support@cresamor.com";

// RESEND_API_KEY is the real, correctly-named var going forward.
// SMTP_PASS is a fallback ONLY -- the key already stored in Render
// under the old SMTP-era var name keeps working without asking anyone
// to re-enter it. Never logged, never included in any thrown/returned
// error value.
function getApiKey() {
  return process.env.RESEND_API_KEY || process.env.SMTP_PASS || null;
}

// Best-effort — never throws. Callers (invitations.js, auth.js) treat a
// failed/unconfigured send as a non-fatal condition, since the raw link
// this email would have contained is always shown/returned to the caller
// through some other channel too (manual copy, SMS, the API response).
async function sendEmail({ to, subject, html, text }) {
  const apiKey = getApiKey();

  if (!apiKey) {
    console.warn(`Email not sent (RESEND_API_KEY not configured) — to=${to} subject="${subject}"`);
    return { sent: false, reason: "not_configured" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS,
        reply_to: process.env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
        to,
        subject,
        html,
        text,
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return { sent: true };
    }

    // Resend's error body is small, provider-side diagnostic JSON (e.g.
    // {"message": "...", "name": "validation_error"}) -- safe to surface,
    // it never echoes back the API key or the request body.
    let providerError = `Resend API returned HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      if (errorBody?.message) providerError = errorBody.message;
    } catch (parseError) {
      // Non-JSON error body -- keep the generic HTTP-status message above.
    }

    console.error(`Failed to send email to=${to} subject="${subject}": ${providerError}`);
    return { sent: false, reason: "send_failed", error: providerError };
  } catch (error) {
    const reason = error.name === "AbortError" ? "Request to Resend timed out" : "Could not reach Resend";
    console.error(`Failed to send email to=${to} subject="${subject}": ${reason}`);
    return { sent: false, reason: "send_failed", error: reason };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { sendEmail };
