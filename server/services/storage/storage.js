/*
  storage.js — the storage abstraction facade. Everything else in the app
  (routes, the backfill script) imports THIS file, never localStorage.js
  or r2Storage.js directly — that's what makes providers swappable.
  Picked once at module load based on STORAGE_PROVIDER (Render env var in
  production, local .env for dev). Unset, or anything other than "r2",
  defaults to local disk, so local dev needs zero new setup.

  Interface (identical for every provider):
    upload(key, filePath, contentType) -> void, streams the temp file at
      filePath to the destination and removes it
    getSignedUrl(key, expiresInSeconds) -> string, a playable URL — signed
      for R2, a plain /uploads/... path for local (no signing needed)
    exists(key) -> boolean
    remove(key) -> void, best-effort — a missing file is not an error

  See ARCHITECTURE.md's "Storage strategy" for the full design (why one
  storage_key column instead of a provider-tracking column, why a temp
  file instead of buffering uploads in memory, migration strategy for
  rows that predate this abstraction).
*/

const provider =
  process.env.STORAGE_PROVIDER === "r2" ? require("./r2Storage") : require("./localStorage");

module.exports = provider;
