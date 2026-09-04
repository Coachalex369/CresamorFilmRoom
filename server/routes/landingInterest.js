/*
  landingInterest.js — public "Become an Early User" interest form,
  submitted from the separate cresamor.com landing page (a different
  origin/deploy from this app), never from an authenticated session.

  Durable-first: the row is committed to the database BEFORE either
  email send is attempted. sendEmail() already never throws (see
  services/email.js) -- notification_sent/confirmation_sent just record
  what happened for later visibility; a failure there never risks the
  lead itself.

  CORS for this one route is intentionally narrower than (and separate
  from) the app-wide policy in app.js -- see the dedicated middleware
  mounted alongside this router in app.js. Never widen the *global*
  CORS list for this; cresamor.com/www.cresamor.com only ever need this
  one public endpoint, not the rest of the API surface.
*/

const express = require("express");

const client = require("../db/client");
const { interestFormLimiter } = require("../middleware/rateLimiters");
const { sendEmail } = require("../services/email");
const { logSecurityEvent } = require("../services/auditLog");

const router = express.Router();

const VALID_ROLES = ["coach", "athlete", "parent", "other"];
const MAX_FIELD_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 2000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimmedOrNull(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

router.post("/api/interest", interestFormLimiter, async (req, res) => {
  try {
    const { name, email, roleOrInterest, sport, teamOrProgram, message, website } = req.body || {};

    // Honeypot: a real visitor never sees or fills this field (hidden in
    // CSS, never focusable). A bot that fills every field it finds gets a
    // normal-looking success response -- never told it was filtered --
    // but nothing is stored or sent.
    if (website) {
      return res.status(200).json({ success: true });
    }

    const cleanName = trimmedOrNull(name);
    const cleanEmail = trimmedOrNull(email)?.toLowerCase();
    const cleanSport = trimmedOrNull(sport);
    const cleanTeamOrProgram = trimmedOrNull(teamOrProgram);
    const cleanMessage = trimmedOrNull(message);

    if (!cleanName || cleanName.length > MAX_FIELD_LENGTH) {
      return res.status(400).json({ error: "Please enter your name." });
    }
    if (!cleanEmail || cleanEmail.length > MAX_FIELD_LENGTH || !EMAIL_PATTERN.test(cleanEmail)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!VALID_ROLES.includes(roleOrInterest)) {
      return res.status(400).json({ error: "Please select who you are." });
    }
    if (cleanSport && cleanSport.length > MAX_FIELD_LENGTH) {
      return res.status(400).json({ error: "Sport is too long." });
    }
    if (cleanTeamOrProgram && cleanTeamOrProgram.length > MAX_FIELD_LENGTH) {
      return res.status(400).json({ error: "Team/program name is too long." });
    }
    if (cleanMessage && cleanMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: "Message is too long." });
    }

    // Durable first -- this row existing is the actual "lead captured"
    // guarantee. Everything after this point is best-effort.
    const insertResult = await client.query(
      `
      INSERT INTO landing_interest_signups
        (name, email, role_or_interest, sport, team_or_program, message, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [cleanName, cleanEmail, roleOrInterest, cleanSport, cleanTeamOrProgram, cleanMessage, req.ip]
    );
    const signupId = insertResult.rows[0].id;

    // Never logs full form contents -- name/email/message stay out of
    // any log line; only the row id and a role for context.
    await logSecurityEvent("landing_interest_submitted", {
      ip: req.ip,
      metadata: { signupId, roleOrInterest },
    });

    const notification = await sendEmail({
      to: "hello@cresamor.com",
      subject: `New Early User interest: ${cleanName} (${roleOrInterest})`,
      html: `<p>New interest form submission.</p><ul><li><strong>Name:</strong> ${cleanName}</li><li><strong>Email:</strong> ${cleanEmail}</li><li><strong>Role/interest:</strong> ${roleOrInterest}</li><li><strong>Sport:</strong> ${cleanSport || "—"}</li><li><strong>Team/program:</strong> ${cleanTeamOrProgram || "—"}</li><li><strong>Message:</strong> ${cleanMessage || "—"}</li></ul>`,
      text: `New interest form submission.\nName: ${cleanName}\nEmail: ${cleanEmail}\nRole/interest: ${roleOrInterest}\nSport: ${cleanSport || "-"}\nTeam/program: ${cleanTeamOrProgram || "-"}\nMessage: ${cleanMessage || "-"}`,
    });

    const confirmation = await sendEmail({
      to: cleanEmail,
      subject: "Thanks for your interest in Cresamor",
      html: `<p>Hi ${cleanName},</p><p>Thanks for your interest in Cresamor! We'll be in touch as we open up early access.</p><p>Early Users receive their first 6 months free.</p><p>— The Cresamor team</p>`,
      text: `Hi ${cleanName},\n\nThanks for your interest in Cresamor! We'll be in touch as we open up early access.\n\nEarly Users receive their first 6 months free.\n\n— The Cresamor team`,
    });

    await client.query(
      "UPDATE landing_interest_signups SET notification_sent = $1, confirmation_sent = $2 WHERE id = $3",
      [notification.sent, confirmation.sent, signupId]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error("POST /api/interest error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

module.exports = router;
