# Cresamor — Architecture

This is the current-state reference: how the system is built, today, as a coherent whole. For *why* it got this way — sprint-by-sprint history, gotchas, lessons learned mid-implementation — see `CLAUDE.md`. That file is the narrative; this one is the map.

## Product shape

Cresamor is built around one long-term hierarchy, even though the MVP only exposes a thin slice of it today:

```
Organization
  └── School
        └── Team
              └── (Season → Game/Practice → Film — not built yet, see "Not yet built" below)
```

Users (coaches, athletes, parents), conversations, and film all attach to this hierarchy via `team_id` (or, for users, via the `team_members` join table). The goal stated by the product owner: an athlete's profile, film, highlights, messages, and eventually calendar/recruiting data should all read as one connected timeline, not disconnected features. Every schema decision below is made to keep that endpoint reachable without a rewrite, even where the MVP UI doesn't expose it yet.

## Stack

- **Backend**: Node/Express, no framework beyond that. Routes are organized by resource under `server/routes/` (one file per resource — `auth`, `videos`, `clips`, `profile`, `conversations`, `teams`), mounted onto a slim `server/app.js` composition root. Cross-cutting logic (permission checks, video processing) lives in `server/services/`.
- **Frontend**: vanilla JS/HTML/CSS, no framework, no bundler, no build step. Static files served directly by Express. Multiple `<script>` tags share one global scope (see `CLAUDE.md`'s "Gotcha" note before adding new top-level names).
- **Database**: Postgres, hosted on Render. Schema changes are additive-only migrations in `server/db/migrations/`, applied by hand via `psql`, numbered and run in order. `server/db/schema.sql` is the *original* bootstrap script and is destructive (`DROP TABLE`) — never run it against a live database with real data.
- **Deployment**: Render web service + Render Postgres, both free tier currently. See "Deployment reality" below for what that actually means operationally.

## Data model

```
organizations ──< schools ──< teams ──< team_members >── users
                                 │                          │
                                 ├──< videos ──< clips ──────┘
                                 │       │
                                 └──< conversations ──< conversation_participants >── users
                                             │
                                             └──< messages >── users (sender_id)
```

- **`organizations` / `schools` / `teams`**: the real hierarchy. One seeded default org/school exists so this isn't empty; multi-tenant admin UI for creating orgs/schools doesn't exist yet.
- **`team_members`**: many-to-many, the *only* source of truth for "who's on what team." No denormalized `users.primary_team_id` — deliberately, to avoid a second place that can drift out of sync. `users.team` (free text) still exists for backward display compatibility but is deprecated; don't write new features against it.
- **`users`**: auth fields (`email`/`password_hash`/`role` — `coach`/`athlete`/`parent`) plus a full athlete-profile field set (`display_name`, `school`, `bio`, `height_inches`, `weight_lbs`, `primary_position`, `goals`, `accomplishments`, `profile_picture_url`, `profile_picture_key`, `social_links` JSONB). The JSONB choice for social/recruiting links is deliberate — that's the one part of the profile shape that's genuinely open-ended (new platforms appear over time), so it's the one field spared from "add a column per feature." `profile_picture_key` (Beta Readiness Sprint 1) routes through the storage abstraction when set; `profile_picture_url` is legacy-only — see "Storage strategy."
- **`videos`**: `team_id`/`film_type` for real team/individual-film classification (replacing an earlier "stuff it into the title string" workaround), `processing_status` (state machine: `uploading` → `processing` → `ready`/`failed`), `thumbnail_url` (schema exists, always `null` so far — nothing generates or displays it yet), `storage_key` (Beta Readiness Sprint 1 — same legacy-vs-abstraction split as `profile_picture_key`; `file_url` is nullable now for exactly this reason).
- **`clips`**: highlights, always real/DB-backed since before any of this session's work.
- **`conversations` / `conversation_participants` / `messages`**: real conversation model. The MVP UI still only ever shows one thread, but the schema already supports per-team, per-category (`coach`/`parent`/`team`/`athlete`/`direct`), or direct-message conversations — building that UI is additive from here, not a schema change.

Every foreign key column is indexed. Postgres doesn't do this automatically (only primary keys and unique constraints get an index for free) — this was a real gap in the original schema, closed across the migrations in this sprint.

## Permission model

**Current state**: one real check exists — `server/services/permissions.js`'s `canAccessConversation(userId, conversationId)`, which queries `conversation_participants` and gates both conversation-message routes with a genuine `403` for non-participants. Everything else in the app has no server-side authorization check at all: routes trust a client-supplied `user_id`/`uploaded_by`, and **no route verifies the JWT bearer token server-side**, even though login/register issue real tokens. This is a known, pre-existing gap, not something any session so far has been asked to fix — flagging it here so it's not mistaken for solved.

**Intended shape**, per the product brief, once real auth verification exists: permission checks should inherit down the hierarchy — Organization → School → Team → Conversation → Resource. `canAccessConversation` is the first real link in that chain. The natural next steps, in order of how directly they build on what exists:
1. Verify the JWT server-side (middleware, applied broadly) — this is the actual prerequisite for everything else meaning anything; without it, every permission check downstream is still trusting a client-supplied identity.
2. `canAccessTeam(userId, teamId)` — checks `team_members`, gates team-scoped resources (videos, future events).
3. Extend video/clip routes to check team membership before returning data, once (1) exists to make the checks meaningful.

A second real check exists alongside it: `canDeleteVideo(userId, videoId)` (same file), gating `DELETE /api/videos/:id` — allowed for the video's original uploader or any user with the `coach` role. Same caveat as above: `userId` is trusted from the request body, not verified against a bearer token.

## Recording pipeline

The benchmark for this pipeline is **instant replay, not fast uploads** — a coach stops recording and is rewatching within a second or two, with sync to the team happening invisibly in the background. Target shape:

```
Camera → Local Library (IndexedDB) → Recording Pipeline → Cloud → Team Library
```

**Ownership hierarchy — the load-bearing design decision, not just today's implementation:**
- **The Recording Library (`client/recordingLibrary.js`) is the single source of truth.** Every recording — from `capture.js` today, and from any future source (external cameras, imports, AI-generated clips, editing tools) — is created in and owned by the library. It's IndexedDB-backed (the first use of IndexedDB in this project — the only browser storage API that can hold Blobs directly; `localStorage` is string-only and far too small for video), and it's the *only* thing that touches IndexedDB. It's event-driven: every mutation (create, lifecycle change, live upload progress, removal) is written through the library's API and emitted to subscribers — nothing polls, and nothing outside this file mutates a recording's state directly.
- **The Recording Pipeline (`client/recordingPipeline.js`) is one consumer of the library, not a peer store.** It asks the library for pending work, performs the upload, and reports results back through the library's own mutation methods — it never touches IndexedDB itself. A future consumer (export, editing, an AI-analysis hand-off) would integrate the same way, without touching the pipeline.
- **The Team Library (the server / `GET /api/videos`) is a synchronized view, not the source of truth for the recording device.** The device always trusts its own Recording Library first; the server is where a synced recording becomes visible to other coaches/athletes.

**Lifecycle**: `local → uploading → synced → processed`, tracked per-recording in the library:
- `local` — recorded, persisted to IndexedDB, not yet successfully synced. Covers both "queued, waiting for network" and "a previous attempt failed, waiting to retry" — both are just `queued: true` at this lifecycle, not separate states.
- `uploading` — the pipeline has an XHR in flight for it right now; live progress is written through `recordingLibrary.updateProgress()` as it goes.
- `synced` — the server responded with a real `videos` row (`serverVideoId` set). The file already exists on disk at this point (multer writes it before the route handler runs), so this is genuinely playable server-side already, independent of `processing_status`.
- `processed` — synced **and** the format doesn't need conversion, so it's playable as-is (advances immediately on sync). A file needing conversion (see below) stays capped at `synced` — the local Blob keeps serving as this device's playable copy until real transcoding exists, which is "Local Film and Team Film are separate concepts" in practice, not a bug.

**Retry**: the pipeline processes one recording at a time (sideline connections are often poor). On failure it reverts the recording to `local`+`queued` rather than tight-looping — retries are triggered by the browser's `online` event and a reconciliation pass on app load (anything stuck `uploading` from a killed tab isn't trustworthy and gets reset). This is a deliberately simple v1: no timer-based polling, no background-sync worker. It's enough to make offline recording and automatic retry real, and it's the seam a real background-sync implementation would replace later without touching anything upstream of it.

**capture.js's role**: a producer, nothing more. On "Use Video" + team confirmed, it hands the local Blob to `recordingLibrary.create()` and the resulting `recordingId` to `recordingPipeline.enqueue()`, then stays on the Review step — that step *is* the instant replay (the same local-Blob preview that's existed since Foundation Sprint Phase 4), and an inline status line (subscribed to the library, not polling) tracks the recording through its lifecycle while the coach keeps watching. There's no separate "Uploading…"/"Done" hand-off screen; closing the modal is how the coach moves on, and syncing continues regardless.

**Film Room's list is a projection**, not a merge of two peer lists: `app.js` reads the library for this device's own not-yet-`processed` recordings (rendered with a lifecycle badge) and layers the server's synchronized `allVideos` on top; once `processed`, the server row is what's shown. The library keeps its own copy underneath regardless of what the team-visible view shows.

**Server side — unchanged this pass.** `POST /api/upload-video` (`server/routes/videos.js`) still only receives the upload and creates the record, responding before processing completes. `server/services/videoProcessing.js` is still the one seam where real transcoding plugs in later. `.MOV` uploads still stay at `processing_status: 'processing'` (`needsFormatConversion()`) instead of falsely reaching `'ready'` — browsers don't reliably play them and no real transcoder exists yet. `GET /api/videos(/:id)` still compute `available` (does the file exist on disk) and `needs_conversion` per request, which is exactly what `recordingPipeline.js` reads off the upload response to decide whether a recording can advance to `processed`.

**Video deletion**: `DELETE /api/videos/:id` (permission described above) deletes the video's `clips` rows, best-effort-deletes the local file (and `thumbnail_url` file, once that's populated) if still present, then removes the `videos` row — for a *server-side* (`processed`) recording. A local-only recording (not yet `processed`) is deleted through `recordingLibrary.remove()` instead — there's no server row to call `DELETE` on yet.

## Storage strategy

**Two distinct storage layers exist, deliberately — don't conflate them:**
1. **This device's own copy** (IndexedDB, via `recordingLibrary.js`) — durable across app reload/restart, but local to the device that recorded it. Not guaranteed forever: `navigator.storage.persist()` isn't called yet, so a browser under real disk pressure can evict it. Documented gap, not implemented.
2. **The team's shared copy** — Postgres row + a file behind the storage abstraction below.

**Server-side storage is now provider-swappable** (`server/services/storage/`), built for Beta Readiness Sprint 1 after Render's ephemeral disk silently lost two real videos (see the playback-fix pass in `CLAUDE.md`'s history) — durability for beta testers' film isn't optional the way it was for MVP development.

- **`storage.js`** — the facade. Everything (routes, the backfill script) imports this, never a specific provider directly. Picks `r2Storage.js` or `localStorage.js` based on `process.env.STORAGE_PROVIDER` (`local` default — local dev needs zero setup; `r2` for production).
- **`localStorage.js`** — the original `uploads/` disk behavior, unchanged, just extracted behind the same interface.
- **`r2Storage.js`** — Cloudflare R2 (S3-API-compatible, via the standard AWS SDK v3: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`). The bucket is **private** — no public access. Playback goes through `getSignedUrl()`, a short-lived (1 hour default) signed GET URL, never a permanent public link.
- Interface, identical for both: `upload(key, filePath, contentType)`, `getSignedUrl(key, expiresInSeconds)`, `exists(key)`, `remove(key)`.
- **Uploads go through a temp file, not an in-memory buffer.** Multer writes to `uploads/.tmp/` (gitignored, self-cleaning); `storage.upload()` streams from there to the real destination — `Upload` from `@aws-sdk/lib-storage` does true streaming multipart for R2 (no full-file memory buffering), which matters on Render's constrained instance for anything approaching a full game recording.

**Schema**: `videos.storage_key` / `users.profile_picture_key` (both nullable, added in migration `006_r2_storage.sql`). `storage_key IS NOT NULL` means "this row goes through the storage abstraction, resolve via `getSignedUrl()`/`exists()`." `NULL` means a **legacy row** — `file_url`/`profile_picture_url` are read directly, exactly as before this migration, forever, regardless of what `STORAGE_PROVIDER` is set to today. Old rows are never rewritten in place; only new uploads adopt `storage_key`. (`videos.file_url`'s original `NOT NULL` constraint was dropped as part of this — new storage_key rows leave it `NULL` by design; every pre-existing row already had a real value, so this was safe to apply immediately.)

**Env vars** (Render dashboard in production, local `.env` for dev — same handling as `DATABASE_URL`/`JWT_SECRET`): `STORAGE_PROVIDER`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.

**Manual Cloudflare setup** (one-time, done by the project owner — Claude Code sessions don't have Cloudflare access):
1. Cloudflare dashboard → R2 → create a bucket (e.g. `cresamor-film`) — private by default, no public-access option to enable.
2. R2 → "Manage API tokens" → create an **Account API token** scoped to R2 Object Read & Write on that bucket (not a global API key). Note the Access Key ID and Secret Access Key (secret shown once).
3. Note the Cloudflare **Account ID** (dashboard sidebar, or the R2 overview page).
4. Render → `CresamorFilmRoom-3` → Environment: set the 5 env vars above. Render redeploys automatically on save.
5. For local testing against the real bucket: add the same 5 vars to the local `.env`; leave `STORAGE_PROVIDER` unset for everyday local dev (keeps using local disk), set it to `r2` only when deliberately testing against the bucket.

**Backfill**: `server/scripts/backfillR2.js` — optional, manual, never auto-run (`node server/scripts/backfillR2.js`). Finds legacy rows whose local file is *still actually present* on disk right now and uploads it to R2, setting `storage_key`. Never deletes the local file or clears `file_url`. Anything already lost to a prior redeploy stays lost — this rescues what's still there today, it doesn't recover history.

**What's still local-disk-only**: nothing new — the `uploads/` directory itself still exists as the destination for the `local` provider and as where legacy files are read from. Thumbnail generation is still not implemented (unchanged); the storage abstraction is ready for it whenever it lands.

## Deployment reality

- Render web service (`CresamorFilmRoom-3`) + Render Postgres (`cresamor_db`), both free tier.
- **`client/app.js`'s `API_URL` is hardcoded to the deployed Render URL, including during local development.** Running `npm run dev` locally serves static files from `localhost:3000`, but every API call still goes to the real deployed backend and real live database — there is no local-only mode. To test new backend routes before deploying, temporarily point `API_URL` at `http://localhost:3000`, test, then revert before committing (every migration/route added this sprint was verified this way).
- Free-tier Render Postgres databases expire after a fixed window and get deleted — this already happened once to this project (see git history around the Sprint 1 security-incident response). Nothing currently monitors for or alerts on this.
- Render's free web service spins down on inactivity (cold start delay on the next request).

## Not yet built (by design, not oversight)

- `seasons`/`games`/`practices` tables — no current feature needs them; adding them now would be schema speculation with nothing to attach to yet. The hierarchy above is deliberately structured so adding a `season_id` to `videos`/future `events` later is one additive column, not a redesign.
- Real video transcoding/compression and thumbnail generation — the pipeline seam exists (`videoProcessing.js`), nothing plugs into it yet.
- Chunked/resumable upload during recording — the architecture doc that motivated the Recording Pipeline named this an explicit future milestone. Today a retry re-sends the whole recording from the Blob still sitting in the library; that's the "simple v1" the pipeline is built around, and it needs server support to do better.
- Real background sync (a service worker retrying while the app is closed, or the Periodic Background Sync API) — `recordingPipeline.js` only runs while the app is open, triggered by the `online` event and a reconciliation pass on load.
- `navigator.storage.persist()` — IndexedDB storage isn't requested as guaranteed/persistent, so it's technically evictable under disk pressure. Documented risk, not yet mitigated.
- A visible Local Film / Team Film split in the UI — the distinction is real in the data model (Recording Library vs. server) but Film Room still renders one unified list.
- `events`/Calendar backend — UI still reads `mockData.js`'s `MOCK_EVENTS`.
- `watch_progress` (Continue Watching) — still `localStorage`, deliberately (it's session/UX state, not data an athlete would expect to migrate with them, though a cross-device "resume where I left off" is a reasonable future upgrade).
- Parent-child account linking — accounts exist, linking doesn't.
- Direct browser-to-R2 uploads (presigned PUT) — uploads still go through the Express server, keeping multer's validation/auth checks in one place. Worth revisiting for very large files.
- JWT server-side verification (see "Permission model" above) — the single biggest real gap between this app and a production-ready one, and the next planned sprint after Beta Readiness Sprint 1 (this one).
