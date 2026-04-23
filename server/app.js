const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const client = require("./db/client");

const app = express();

const uploadsDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const upload = multer({ storage });

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));
app.use("/uploads", express.static(uploadsDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({ message: "Cresamor backend is alive" });
});

/* ---------- AUTH ---------- */

app.post("/api/auth/register", async (req, res) => {
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

    const token = jwt.sign(user, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({ token, user });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
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

/* ---------- VIDEOS ---------- */

app.get("/api/videos", async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT *
      FROM videos
      ORDER BY id DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/videos error:", err);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

app.post("/api/videos", async (req, res) => {
  try {
    const { title, file_url, uploaded_by } = req.body;

    if (!title || !file_url || !uploaded_by) {
      return res.status(400).json({ error: "Missing required video fields" });
    }

    const result = await client.query(
      `
      INSERT INTO videos (title, file_url, uploaded_by)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [title, file_url, uploaded_by]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/videos error:", err);
    res.status(500).json({ error: "Failed to create video" });
  }
});

app.post("/api/upload-video", upload.single("video"), async (req, res) => {
  console.log("UPLOAD ROUTE HIT");
    try {const { title, uploaded_by } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No video file uploaded" });
    }

    if (!title || !uploaded_by) {
      return res.status(400).json({ error: "Missing required upload fields" });
    }

    const fileUrl = `/uploads/${req.file.filename}`;

    const result = await client.query(
      `
      INSERT INTO videos (title, file_url, uploaded_by)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [title, fileUrl, uploaded_by]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/upload-video error:", err);
    res.status(500).json({ error: "Failed to upload video" });
  }
});

/* ---------- CLIPS ---------- */

app.post("/api/clips", async (req, res) => {
  try {
    const { title, start_time, end_time, video_id, user_id } = req.body;

    if (
      !title ||
      start_time === undefined ||
      end_time === undefined ||
      !video_id ||
      !user_id
    ) {
      return res.status(400).json({ error: "Missing required clip fields" });
    }

    const result = await client.query(
      `
      INSERT INTO clips (title, start_time, end_time, video_id, user_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [title, start_time, end_time, video_id, user_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/clips error:", err);
    res.status(500).json({ error: "Failed to save clip" });
  }
});

app.get("/api/users/:id/clips", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT clips.*
      FROM clips
      WHERE clips.user_id = $1
      ORDER BY clips.id DESC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/users/:id/clips error:", err);
    res.status(500).json({ error: "Failed to fetch user clips" });
  }
});

module.exports = app;