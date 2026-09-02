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

// Production bug fix (Beta Readiness Sprint 2 follow-up): a real
// MediaRecorder Blob's `type` — and therefore the multipart Content-Type
// multer reports as `file.mimetype` — carries codec parameters, e.g.
// "video/mp4;codecs=avc1,mp4a" (see capture.js's pickSupportedMimeType()).
// The allowlist below is keyed on bare container types, so an exact-match
// lookup against the untouched header silently rejected every real
// recording while accepting clean test values like "video/mp4" — the
// underlying cause of the "authenticated upload always fails" regression.
// Normalize to the part before the first ";" before every lookup.
function normalizeContentType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function extensionFor(category, contentType) {
  return allowedTypesFor(category)[normalizeContentType(contentType)] || "";
}

// Exposed so routes can use the SAME allowlist for their own first-layer
// multer fileFilter — one source of truth, not two lists that can drift.
function isAllowed(category, contentType) {
  return Boolean(allowedTypesFor(category)[normalizeContentType(contentType)]);
}

// Team Highlights, Slice 1: onProgress (optional) is a provider-neutral
// hook, ({ loadedBytes, totalBytes }) => void, called as upload progress
// is observed — currently only meaningfully invoked by r2Storage (its
// underlying @aws-sdk/lib-storage Upload already emits real
// httpUploadProgress events for a multipart transfer); localStorage's
// single fs.rename() has no intermediate progress to report and simply
// never calls it, which is a valid, harmless no-op for any caller.
// Exists so a long-running upload's lease can be renewed on genuine
// progress, not just relying on the upload-attempt's initial fixed
// lease window to cover a legitimately large file end-to-end.
async function upload(key, filePath, contentType, { category, onProgress } = {}) {
  const allowed = allowedTypesFor(category);
  const normalized = normalizeContentType(contentType);

  if (!allowed[normalized]) {
    throw new Error(
      `Rejected upload: content type "${contentType}" is not allowed${
        category ? ` for category "${category}"` : ""
      }`
    );
  }

  return provider.upload(key, filePath, contentType, { onProgress });
}

module.exports = {
  ...provider,
  upload,
  extensionFor,
  isAllowed,
};
