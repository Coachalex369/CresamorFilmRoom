const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const client = require("../db/client");
const storage = require("../services/storage/storage");

const router = express.Router();

// Beta Readiness Sprint 1 (R2 migration): same temp-dir-then-storage.upload()
// pattern as videos.js — see that file's comment and ARCHITECTURE.md's
// "Storage strategy" for why.
const tempProfilePicturesDir = path.join(__dirname, "../../uploads/.tmp");
if (!fs.existsSync(tempProfilePicturesDir)) {
  fs.mkdirSync(tempProfilePicturesDir, { recursive: true });
}

const profilePictureStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempProfilePicturesDir);
  },
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const uploadProfilePicture = multer({
  storage: profilePictureStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const PROFILE_FIELDS = `
  id, email, role, display_name, school, team, graduation_year, profile_picture_url,
  profile_picture_key,
  bio, height_inches, weight_lbs, primary_position, goals, accomplishments, social_links
`;

// profile_picture_key IS NOT NULL means this row goes through the storage
// abstraction (same rule as videos.storage_key) — resolve it to a
// signed/direct URL and surface it as profile_picture_url so the client
// (which already just reads profile_picture_url) needs no changes.
async function withResolvedPhotoUrl(user) {
  if (!user.profile_picture_key) return user;

  return {
    ...user,
    profile_picture_url: await storage.getSignedUrl(user.profile_picture_key),
  };
}

router.get("/api/users/:id/profile", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `SELECT ${PROFILE_FIELDS} FROM users WHERE id = $1`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(await withResolvedPhotoUrl(result.rows[0]));
  } catch (err) {
    console.error("GET /api/users/:id/profile error:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

router.put("/api/users/:id/profile", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      display_name,
      school,
      team,
      graduation_year,
      // Foundation Sprint Phase 1: schema is ready for these even though no
      // UI sends them yet (see CLAUDE.md — "prepare the database, not every
      // screen"). Accepting them now means the eventual profile-editing UI
      // for bio/measurements/goals needs zero backend changes to ship.
      bio,
      height_inches,
      weight_lbs,
      primary_position,
      goals,
      accomplishments,
      social_links,
    } = req.body;

    const result = await client.query(
      `
      UPDATE users
      SET display_name = $1, school = $2, team = $3, graduation_year = $4,
          bio = COALESCE($5, bio),
          height_inches = COALESCE($6, height_inches),
          weight_lbs = COALESCE($7, weight_lbs),
          primary_position = COALESCE($8, primary_position),
          goals = COALESCE($9, goals),
          accomplishments = COALESCE($10, accomplishments),
          social_links = COALESCE($11, social_links)
      WHERE id = $12
      RETURNING ${PROFILE_FIELDS}
      `,
      [
        display_name || null,
        school || null,
        team || null,
        graduation_year || null,
        bio || null,
        height_inches || null,
        weight_lbs || null,
        primary_position || null,
        goals || null,
        accomplishments || null,
        social_links ? JSON.stringify(social_links) : null,
        id,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(await withResolvedPhotoUrl(result.rows[0]));
  } catch (err) {
    console.error("PUT /api/users/:id/profile error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.post("/api/users/:id/photo", uploadProfilePicture.single("photo"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded" });
    }

    // Beta Readiness Sprint 1: same storage_key pattern as videos — new
    // uploads go through the active provider, profile_picture_url stays
    // NULL for these rows (resolved on read via withResolvedPhotoUrl).
    const storageKey = `profile-pictures/${req.file.filename}`;
    await storage.upload(storageKey, req.file.path, req.file.mimetype);

    const result = await client.query(
      `
      UPDATE users
      SET profile_picture_key = $1
      WHERE id = $2
      RETURNING ${PROFILE_FIELDS}
      `,
      [storageKey, id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(await withResolvedPhotoUrl(result.rows[0]));
  } catch (err) {
    console.error("POST /api/users/:id/photo error:", err);
    res.status(500).json({ error: "Failed to upload photo" });
  }
});

module.exports = router;
