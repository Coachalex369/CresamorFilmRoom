const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const client = require("../db/client");
const { logSecurityEvent } = require("../services/auditLog");
const { sendEmail } = require("../services/email");
const { loginLimiter, registerLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

const DEFAULT_ALLOWED_ORIGIN = "https://cresamorfilmroom-3.onrender.com";
const BASE_URL = process.env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour — short, since unlike an
// invitation this token grants direct account access once used.

function hashResetToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function signSessionToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

router.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await client.query(
      `
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, $3)
      RETURNING id, email, role
      `,
      [email, hashedPassword, role]
    );

    const user = result.rows[0];

    // Foundation Sprint Phase 2: preserve pre-conversation-model behavior
    // (every user could read/post the one shared thread) by auto-joining
    // new signups to the default conversation. Once real team-scoped
    // conversations exist, this should become "join the conversation(s)
    // for whatever team they join," not a blanket auto-join — flagged in
    // the Phase 2 report as a placeholder, not a permanent design.
    await client.query(
      `
      INSERT INTO conversation_participants (conversation_id, user_id)
      SELECT id, $1 FROM conversations ORDER BY id LIMIT 1
      ON CONFLICT (conversation_id, user_id) DO NOTHING
      `,
      [user.id]
    );

    // JWT payload carries only the id — email/role are reloaded from
    // Postgres on every authenticated request (see middleware/authenticate.js)
    // rather than trusted from a token that could be up to 7 days stale.
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    await logSecurityEvent("login_success", { userId: user.id, ip: req.ip, metadata: { via: "register" } });

    res.status(201).json({ token, user });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const result = await client.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      await logSecurityEvent("login_failure", { ip: req.ip, metadata: { email } });
      return res.status(401).json({ error: "Invalid login" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      await logSecurityEvent("login_failure", { userId: user.id, ip: req.ip, metadata: { email } });
      return res.status(401).json({ error: "Invalid login" });
    }

    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    // Same minimal-payload rule as register — only id is signed into the
    // token; the response body still returns the full payload for the
    // client to use immediately.
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    await logSecurityEvent("login_success", { userId: user.id, ip: req.ip });

    res.json({ token, user: payload });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Teams MVP: forgot-password. Deliberately returns the SAME response
// (status + body) whether or not the email matches an account — "Do not
// reveal whether an email address has an account when requesting a
// password reset" is a hard requirement, not just a nicety, so the
// account-lookup branch below only ever affects side effects (token
// creation, email send), never the HTTP response shape.
router.post("/api/auth/forgot-password", loginLimiter, async (req, res) => {
  const NEUTRAL_MESSAGE = "If an account exists for that email, password reset instructions have been sent.";

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const userResult = await client.query("SELECT id, email FROM users WHERE email = $1", [
      String(email).trim().toLowerCase(),
    ]);
    const user = userResult.rows[0];

    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

      // Invalidate any prior outstanding tokens for this user before
      // issuing a new one — only the most recent reset request should
      // ever be usable.
      await client.query(
        "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        [user.id]
      );

      await client.query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${BASE_URL}/?reset=${rawToken}`;
      await sendEmail({
        to: user.email,
        subject: "Reset your Cresamor password",
        html: `<p>Click the link below to reset your Cresamor password. This link expires in 1 hour and can only be used once.</p><p><a href="${resetUrl}">Reset password</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
        text: `Reset your Cresamor password: ${resetUrl} (expires in 1 hour, one-time use). If you didn't request this, ignore this email.`,
      });

      await logSecurityEvent("password_reset_requested", { userId: user.id, ip: req.ip });
    } else {
      // Still log the attempt (no userId, since none matched) — audit
      // trail without confirming/denying the email exists.
      await logSecurityEvent("password_reset_requested", { ip: req.ip });
    }

    res.json({ message: NEUTRAL_MESSAGE });
  } catch (err) {
    console.error("POST /api/auth/forgot-password error:", err);
    // Still neutral, even on an internal error — a differently-shaped
    // error response would itself leak whether the email existed.
    res.json({ message: NEUTRAL_MESSAGE });
  }
});

// Teams MVP: reset-password. Auto-logs the user in on success (returns
// {token, user} exactly like login/register) — they already proved
// account ownership by presenting a valid, unused, unexpired emailed
// token, so a second manual login is unnecessary friction, and this lets
// the client run the identical post-auth pending-invitation check every
// other auth success path already runs.
router.post("/api/auth/reset-password", loginLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }

    const tokenHash = hashResetToken(token);

    const tokenResult = await client.query(
      `
      SELECT * FROM password_reset_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      `,
      [tokenHash]
    );
    const resetToken = tokenResult.rows[0];

    if (!resetToken) {
      return res.status(400).json({
        error: "This password reset link has expired or already been used. Request a new one.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const userResult = await client.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email, role",
      [hashedPassword, resetToken.user_id]
    );
    const user = userResult.rows[0];

    await client.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [resetToken.id]);
    // Invalidate any other outstanding tokens for this user too — a
    // password reset should retire every pending reset attempt, not just
    // the one that was used.
    await client.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [resetToken.user_id]
    );

    const sessionToken = signSessionToken(user.id);

    await logSecurityEvent("password_reset_completed", { userId: user.id, ip: req.ip });

    res.json({ token: sessionToken, user });
  } catch (err) {
    console.error("POST /api/auth/reset-password error:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

module.exports = router;
