const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const client = require("../db/client");

const router = express.Router();

router.post("/api/auth/register", async (req, res) => {
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

    const token = jwt.sign(user, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({ token, user });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/api/auth/login", async (req, res) => {
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
      return res.status(401).json({ error: "Invalid login" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ token, user: payload });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
