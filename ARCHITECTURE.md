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

## Video pipeline

```
Upload → Validate → Create DB record (status: uploading) → enqueueVideoProcessingAsync
  → status: processing → [Video Converter: TODO] → [Thumbnail Generator: TODO] → status: ready
```

`POST /api/upload-video` (in `server/routes/videos.js`) only receives the upload and creates the record — it does not wait for processing, and responds immediately. `server/services/videoProcessing.js` is the one seam where real work plugs in later; it currently does nothing but flip status flags (with a deliberate, TODO-marked artificial delay standing in for real processing time). Clients that care about the real status poll `GET /api/videos/:id`.

**Nothing today gates on `processing_status`** — a video is playable via its `file_url` the instant the file lands on disk, regardless of status. The status field is honest UI feedback (so uploaders aren't staring at a blank screen), not an access control mechanism. When real transcoding lands and produces a *different* playable file (e.g. a compressed version), that's the point where playback would start caring about status — not before.

## Storage strategy

**Current**: local disk, under `uploads/` (videos) and `uploads/profile-pictures/` (profile photos), served via Express static middleware. On Render's free tier this is ephemeral — wiped on every redeploy/restart. Acceptable for MVP development, not for production.

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
- `events`/Calendar backend — UI still reads `mockData.js`'s `MOCK_EVENTS`.
- `watch_progress` (Continue Watching) — still `localStorage`, deliberately (it's session/UX state, not data an athlete would expect to migrate with them, though a cross-device "resume where I left off" is a reasonable future upgrade).
- Parent-child account linking — accounts exist, linking doesn't.
- JWT server-side verification (see "Permission model" above) — the single biggest real gap between this app and a production-ready one.
