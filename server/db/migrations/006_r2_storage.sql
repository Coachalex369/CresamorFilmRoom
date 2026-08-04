-- Beta Readiness Sprint 1 — Cloudflare R2 storage migration.
--
-- One nullable column per table, not a storage_provider enum column:
-- storage_key IS NOT NULL unambiguously means "this row's file lives
-- behind the storage abstraction" (local disk or R2, whichever
-- STORAGE_PROVIDER is active) — no second column to keep in sync, no
-- backfill needed for existing rows (NULL is correct for every row that
-- predates this migration). file_url / profile_picture_url are untouched
-- and become legacy-only fields — existing rows keep working exactly as
-- they do today via the same fallback logic, indefinitely, in parallel
-- with new rows using storage_key. See ARCHITECTURE.md's storage section.
--
-- Additive only, safe to run once against production, safe to re-run.

ALTER TABLE videos ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_key TEXT;

-- videos.file_url is NOT NULL from the original schema.sql — every row
-- had to have one when file_url was the only way to locate a file. New
-- storage_key rows leave file_url NULL by design (see above), so the
-- constraint has to relax. Every existing row already has a real
-- file_url, so this is safe to apply immediately — it only permits
-- something new, it can't invalidate anything already in the table.
ALTER TABLE videos ALTER COLUMN file_url DROP NOT NULL;
