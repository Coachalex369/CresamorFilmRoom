const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const client = require("../db/client");
const storage = require("../services/storage/storage");
const { authenticate } = require("../middleware/authenticate");
const { requireOwner } = require("../middleware/authorize");
const { uploadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// Beta Readiness Sprint 2: environment-driven, matching MAX_VIDEO_UPLOAD_MB
// in videos.js — see that file's comment for why this isn't hardcoded.
const MAX_PHOTO_UPLOAD_MB = Number(process.env.MAX_PHOTO_UPLOAD_MB) || 5;

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
    // Only the TEMP filename (uploads/.tmp/) — never the storage key the
    // photo actually gets stored/served under. Deleted the moment
    // storage.upload() finishes.
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const uploadProfilePicture = multer({
  storage: profilePictureStorage,
  // First layer of MIME validation, reusing storage.js's allowlist (see
  // videos.js's identical pattern) — tighter than the old "any image/*"
  // check, which would have accepted image/svg+xml (SVGs can carry
  // embedded scripts, not something to allow through a profile photo
  // upload).
  fileFilter: (req, file, cb) => {
    if (!storage.isAllowed("image", file.mimetype)) {
      return cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_PHOTO_UPLOAD_MB * 1024 * 1024 },
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

router.get("/api/users/:id/profile", authenticate, async (req, res) => {
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

router.put("/api/users/:id/profile", authenticate, requireOwner("id"), async (req, res) => {
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

router.post(
  "/api/users/:id/photo",
  authenticate,
  requireOwner("id"),
  uploadLimiter,
  uploadProfilePicture.single("photo"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!req.file) {
        return res.status(400).json({ error: "No photo uploaded" });
      }

      // Beta Readiness Sprint 1: same storage_key pattern as videos — new
      // uploads go through the active provider, profile_picture_url stays
      // NULL for these rows (resolved on read via withResolvedPhotoUrl).
      // Opaque key: no original filename, just the owning user's id and a
      // random UUID — see videos.js's identical reasoning.
      const extension = storage.extensionFor("image", req.file.mimetype);
      const storageKey = `profile-pictures/${id}/${crypto.randomUUID()}${extension}`;
      await storage.upload(storageKey, req.file.path, req.file.mimetype, { category: "image" });

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
  }
);

module.exports = router;
