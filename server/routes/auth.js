const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const client = require("../db/client");
const { logSecurityEvent } = require("../services/auditLog");
const { loginLimiter, registerLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

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

module.exports = router;
