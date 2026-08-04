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

**Current state (Beta Readiness Sprint 2 — server-side auth): every route that returns or mutates non-public data now verifies the JWT bearer token server-side.** This closed the single biggest gap in the app — previously, no route checked the token at all, and identity was whatever a client claimed in a body/query field (`user_id`, `uploaded_by`, `requesting_user_id`, `sender_id`). Two real privilege bugs existed as a direct result and were fixed in this sprint: `GET /api/conversations` returned every conversation in the system when `user_id` was omitted, and `POST /api/users/:id/teams` let any caller grant themselves (or anyone) a coach-level `role_on_team` with no check at all.

**Auth is split into two middleware modules**, deliberately — "who are you" and "what can you do" are different concerns:
- **`server/middleware/authenticate.js`** — `authenticate(req, res, next)`. Reads `Authorization: Bearer <token>`, verifies it against `JWT_SECRET`, then reloads the user fresh from Postgres by `id` and attaches a minimal `req.user = { id, email, role }`. The JWT payload itself carries **only `{ id }`** — email/role are never trusted from the token, so a role change or account deletion takes effect on the very next request instead of waiting out the token's 7-day expiry. Every rejection path (missing header, bad signature, expired token, token for a deleted user) returns the same generic `401` and gets audit-logged as `auth_rejected`, so a caller can't fingerprint the failure reason and there's a record of probing behavior.
- **`server/middleware/authorize.js`** — composable checks used *after* `authenticate`: `requireRole(...roles)`, `requireOwner(paramName)`, `requireConversationParticipant(paramName)`. Routes read declaratively — `router.post("/api/teams", authenticate, requireRole("coach"), handler)` — for anything that's a single binary gate on one resource. Routes whose "authorization" is really a per-row filter over a list (`GET /api/videos`, `GET /api/conversations`) don't fit that shape and stay behind `authenticate` alone, filtering inline via `permissions.js` — there's no single yes/no gate a middleware could enforce before the handler runs for those.

**`server/services/permissions.js`** holds the actual resource-specific rules, all now driven by `req.user.id` rather than a client-supplied value:
- `canAccessConversation(userId, conversationId)` — queries `conversation_participants`.
- `canDeleteVideo(userId, videoId)` — original uploader or any `coach`.
- `canAccessTeam(userId, teamId)` — queries `team_members`; a coach passes automatically (coach access is a superset everywhere in this app).
- `canViewVideo(userId, video)` — `video.team_id === null` (the "unassigned" case) is visible only to the uploader or a coach; otherwise follows `canAccessTeam`.
- `canManageTeamMembership(userId, targetUserId, roleOnTeam)` — the role-escalation fix: a coach may set any membership including a coach-level role; a non-coach may only add *themselves*, and only with a non-coach role.

**Known, deliberate scope limits** (flagged, not oversights):
- **Team-scoped video visibility is a real behavior change**: `GET /api/videos` previously returned everything to everyone; it now filters to team-visible-or-own-uploaded per row.
- **No parent-child linking table exists**, so parents get no broad access from role alone — own account/profile/conversations-they're-actually-in only. Inventing broad parent access from role alone was explicitly rejected as unsafe.
- **No coach-can-edit-athlete-profile permission exists.** `PUT /api/users/:id/profile` is strictly owner-only until that's a defined product feature.
- **No token revocation list.** Logout is client-side-only (clears `localStorage`); a JWT remains cryptographically valid until its natural 7-day expiry even after "logout." Accepted limitation for a beta, not solved here.
- **`GET /api/users/:id/clips`/`GET /api/users/:id/teams` visibility was deliberately left open** (any authenticated user can view) rather than narrowed to owner/team-only — narrowing wasn't asked for and is a separate product decision.

**Security audit log** (`security_audit_log` table, migration `007`): a lightweight, durable, queryable trail — not process logs, which Render doesn't retain or let you query. `server/services/auditLog.js`'s `logSecurityEvent(eventType, { userId, ip, metadata })` is called (awaited, so an entry is guaranteed to exist before the response returns) at: `login_success`, `login_failure`, `auth_rejected`, `video_deleted`, `team_membership_changed`, and rate-limit hits (`login_rate_limited`, etc.). Never logs a token, password, or password hash. **Retention**: no automatic pruning ships — at beta scale, unbounded retention is the safer default for a security trail than an aggressive auto-expiry that could delete evidence of a real incident before anyone's looked at it. When it does need pruning, the plan is a manual `DELETE FROM security_audit_log WHERE created_at < now() - interval '1 year'`, matching this project's "no cron jobs, no background workers" pattern — not automated unless row count or compliance needs actually demand it.

**Other beta hardening shipped in this sprint**:
- **Rate limiting** (`server/middleware/rateLimiters.js`, `express-rate-limit`, in-memory store — fine for a single Render instance): login (10/15min/IP), register (5/hour/IP), video/photo upload (30/hour/IP). Deliberately loose, beta-appropriate limits, not production-hardened ones.
- **Helmet** (`app.use(helmet())` in `server/app.js`) — standard security headers, default CSP. Safe with no config exceptions: the client has no inline scripts/styles and no external CDN resources.
- **CORS is environment-driven**, not hardcoded: `ALLOWED_ORIGIN` env var, defaulting to the deployed Render origin if unset.
- **Upload size limits are environment-driven**: `MAX_VIDEO_UPLOAD_MB` (default 3072) and `MAX_PHOTO_UPLOAD_MB` (default 5), both wired into their routes' multer config. The video default was raised well past the historical 500MB figure — the temp-file-then-stream upload path never buffers a file in memory, so the real ceiling is disk space and abuse prevention, not RAM.
- **`express.json({ limit: "100kb" })`** made explicit (was relying on Express's implicit default).

**Env vars added this sprint** (Render dashboard in production, local `.env` for dev — same handling as `DATABASE_URL`/`JWT_SECRET`/the R2 vars): `ALLOWED_ORIGIN`, `MAX_VIDEO_UPLOAD_MB`, `MAX_PHOTO_UPLOAD_MB`. All three have safe in-code defaults, so leaving them unset in an existing environment changes nothing.

**Testing**: `server/scripts/testAuth.js` — plain Node, no test-framework dependency, run by hand (`node server/scripts/testAuth.js`). Spins up the real app on a throwaway local port and drives it over real HTTP requests against whatever `DATABASE_URL` is configured, using clearly-namespaced test users/teams/videos that it deletes in a `finally` block regardless of pass/fail. Covers token rejection paths, the two fixed bugs, ownership/role/participant gates, forged-identity-field rejection, rate limiting, and audit-log writes. Does **not** cover signed R2 playback or a real browser exercising the Recording Pipeline's XHR flow — those need manual verification once R2 setup (see "Storage strategy") is complete.

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
- **`r2Storage.js`** — Cloudflare R2 (S3-API-compatible, via the standard AWS SDK v3: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`). The bucket is **private** — no public access. Playback goes through `getSignedUrl()`, a short-lived signed GET URL (20 minutes, deliberately short — a coach reviewing film longer than that, or seeking after the window closes, hits a 403 on the next range request and has to reselect the video; no mitigation for that yet), never a permanent public link.
- Interface, identical for both: `upload(key, filePath, contentType, { category })`, `getSignedUrl(key, expiresInSeconds)`, `exists(key)`, `remove(key)`.
- **Uploads go through a temp file, not an in-memory buffer.** Multer writes to `uploads/.tmp/` (gitignored, self-cleaning); `storage.upload()` streams from there to the real destination — `Upload` from `@aws-sdk/lib-storage` does true streaming multipart for R2 (no full-file memory buffering), which matters on Render's constrained instance for anything approaching a full game recording.
- **Object keys are opaque UUIDs, not filenames.** `videos/{teamId|"unassigned"}/{year}/{uuid}.{ext}` and `profile-pictures/{userId}/{uuid}.{ext}` — the original uploaded filename never appears anywhere in the key. `year` is the video's actual `created_at` year for backfilled rows (not "whenever the script happens to run"). The extension is real (needed for `needsFormatConversion()`'s `.mov` detection and generally useful for content-type inference) but is derived from `storage.extensionFor(category, mimetype)` — the validated allowlist below — not from the client-supplied original filename.
- **MIME validation is enforced twice.** Each route's multer `fileFilter` is the first, fast-fail layer (rejects before a temp file is even fully written) — `videos.js` and `profile.js` both call `storage.isAllowed(category, mimetype)` rather than keeping their own separate lists. `storage.upload()` itself is the second layer: every upload, from every route, passes through this one facade function, so a bad content type can't slip through even if a specific route's filter is missing, buggy, or bypassed. One shared allowlist (`storage.js`) is the single source of truth for both layers — `video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo`, `video/3gpp`; `image/jpeg`, `image/png`, `image/webp`, `image/gif`. Notably excludes `image/svg+xml` (SVGs can carry embedded scripts) even though the old profile-picture check (`mimetype.startsWith("image/")`) would have allowed it.

**Schema**: `videos.storage_key` / `users.profile_picture_key` (both nullable, added in migration `006_r2_storage.sql`). `storage_key IS NOT NULL` means "this row goes through the storage abstraction, resolve via `getSignedUrl()`/`exists()`." `NULL` means a **legacy row** — `file_url`/`profile_picture_url` are read directly, exactly as before this migration, forever, regardless of what `STORAGE_PROVIDER` is set to today. Old rows are never rewritten in place; only new uploads adopt `storage_key`. (`videos.file_url`'s original `NOT NULL` constraint was dropped as part of this — new storage_key rows leave it `NULL` by design; every pre-existing row already had a real value, so this was safe to apply immediately.)

**Bug caught and fixed while adding opaque keys**: `needsFormatConversion()` (`videoProcessing.js`) checked `video.file_url` to detect `.MOV` uploads — for `storage_key` rows, `file_url` is `NULL`, so this silently never fired for anything uploaded through the R2-migration code path (MOV files would have incorrectly reached `processing_status: 'ready'` instead of correctly holding at `'processing'`). Fixed to check `storage_key` first, falling back to `file_url` for legacy rows.

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
- Parent-child account linking — accounts exist, linking doesn't. Parent access stays deliberately narrow (see "Permission model") until this exists.
- Direct browser-to-R2 uploads (presigned PUT) — uploads still go through the Express server, keeping multer's validation/auth checks in one place. Worth revisiting for very large files.
- Server-side token revocation (see "Permission model") — logout is client-side-only; a JWT stays valid until natural expiry.
- Coach-editing-an-athlete's-profile — no such permission exists; profile edits are strictly owner-only.
- An org-admin role tier — any coach can create a team; there's no finer-grained gate above "coach" yet.
