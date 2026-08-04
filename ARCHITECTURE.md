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
- **`users`**: auth fields (`email`/`password_hash`/`role` — `coach`/`athlete`/`parent`) plus a full athlete-profile field set (`display_name`, `school`, `bio`, `height_inches`, `weight_lbs`, `primary_position`, `goals`, `accomplishments`, `profile_picture_url`, `social_links` JSONB). The JSONB choice for social/recruiting links is deliberate — that's the one part of the profile shape that's genuinely open-ended (new platforms appear over time), so it's the one field spared from "add a column per feature."
- **`videos`**: `team_id`/`film_type` for real team/individual-film classification (replacing an earlier "stuff it into the title string" workaround), `processing_status` (state machine: `uploading` → `processing` → `ready`/`failed`), `thumbnail_url` (schema exists, always `null` so far — nothing generates or displays it yet).
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

**Two distinct storage layers exist now, deliberately — don't conflate them:**
1. **This device's own copy** (IndexedDB, via `recordingLibrary.js`) — durable across app reload/restart, but local to the device that recorded it. Not guaranteed forever: `navigator.storage.persist()` isn't called yet, so a browser under real disk pressure can evict it. Documented gap, not implemented this pass.
2. **The team's shared copy** (Postgres `videos` row + a file on the server) — below.

**Server-side, current**: local disk, under `uploads/` (videos) and `uploads/profile-pictures/` (profile photos), served via Express static middleware. On Render's free tier this is ephemeral — wiped on every redeploy/restart. This isn't theoretical: it already happened once, silently, and orphaned two `videos` rows pointing at files that no longer existed (surfaced as player 404s, diagnosed and cleaned up — see git history around the playback-fix pass). Acceptable for MVP development, not for production.

**Migration path to object storage** (documented, not implemented — see the Sprint 3 architecture-review response for the full reasoning):
1. Introduce an S3-compatible bucket (Cloudflare R2 recommended — no egress fees, meaningful for a video-heavy app).
2. Swap `multer.diskStorage` for `multer-s3` (or R2's S3-compatible equivalent) in `server/routes/videos.js` and `server/routes/profile.js` — the only code that needs to change.
3. **No database schema change required.** `file_url`/`profile_picture_url`/`thumbnail_url` are already plain strings, and the client already branches on `startsWith("http")` wherever it resolves a URL (see `resolveUploadUrl()` in `home.js`, and the equivalent logic in `capture.js`) — a bucket URL is just a different string in the same column. This was future-proofed by accident, but it holds.
4. One-off migration script: list existing local files, upload to the bucket, update the corresponding `file_url` rows. A few dozen lines, run once.
5. Decide public-bucket-plus-CDN vs. signed URLs based on whether film needs to stay private to a team — that decision interacts with the permission model above, so it's worth deciding deliberately rather than defaulting.

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
- JWT server-side verification (see "Permission model" above) — the single biggest real gap between this app and a production-ready one.
