/*
  storage.js — the storage abstraction facade. Everything else in the app
  (routes, the backfill script) imports THIS file, never localStorage.js
  or r2Storage.js directly — that's what makes providers swappable.
  Picked once at module load based on STORAGE_PROVIDER (Render env var in
  production, local .env for dev). Unset, or anything other than "r2",
  defaults to local disk, so local dev needs zero new setup.

  Interface (identical for every provider):
    upload(key, filePath, contentType, { category }) -> void, streams the
      temp file at filePath to the destination and removes it. category
      ("video" | "image") is optional but recommended — see MIME
      validation below.
    getSignedUrl(key, expiresInSeconds) -> string, a playable URL — signed
      for R2, a plain /uploads/... path for local (no signing needed)
    exists(key) -> boolean
    remove(key) -> void, best-effort — a missing file is not an error

  MIME validation lives HERE, not just in each route's multer fileFilter.
  Route-level validation is the first, fast-fail layer (rejects before
  even writing a temp file); this is the second layer — every upload
  passes through this facade regardless of which route or provider is
  involved, so it's the one place a bad content type can never slip
  through even if a route's own filter is missing, buggy, or bypassed.
  extensionFor() is exposed so routes build storage_key file extensions
  from this same allowlist rather than trusting the client-supplied
  original filename — see ARCHITECTURE.md's "Storage strategy" for why
  keys are opaque UUIDs, not filenames.

  See ARCHITECTURE.md's "Storage strategy" for the full design (why one
  storage_key column instead of a provider-tracking column, why a temp
  file instead of buffering uploads in memory, migration strategy for
  rows that predate this abstraction).
*/

const provider =
  process.env.STORAGE_PROVIDER === "r2" ? require("./r2Storage") : require("./localStorage");

const ALLOWED_CONTENT_TYPES = {
  video: {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-msvideo": ".avi",
    "video/3gpp": ".3gp",
  },
  image: {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  },
};

function allowedTypesFor(category) {
  if (category && ALLOWED_CONTENT_TYPES[category]) return ALLOWED_CONTENT_TYPES[category];
  return { ...ALLOWED_CONTENT_TYPES.video, ...ALLOWED_CONTENT_TYPES.image };
}

function extensionFor(category, contentType) {
  return allowedTypesFor(category)[contentType] || "";
}

// Exposed so routes can use the SAME allowlist for their own first-layer
// multer fileFilter — one source of truth, not two lists that can drift.
function isAllowed(category, contentType) {
  return Boolean(allowedTypesFor(category)[contentType]);
}

async function upload(key, filePath, contentType, { category } = {}) {
  const allowed = allowedTypesFor(category);

  if (!allowed[contentType]) {
    throw new Error(
      `Rejected upload: content type "${contentType}" is not allowed${
        category ? ` for category "${category}"` : ""
      }`
    );
  }

  return provider.upload(key, filePath, contentType);
}

module.exports = {
  ...provider,
  upload,
  extensionFor,
  isAllowed,
};
