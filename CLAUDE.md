# Cresamor Film Room — CLAUDE.md

Guidance for future Claude Code sessions working in this repo.

**For current architecture** (data model, permission model, video pipeline, storage migration path, deployment reality) **see `ARCHITECTURE.md`.** This file is session guidance: conventions, gotchas that cost real debugging time, and a condensed history of what changed and why — it intentionally doesn't re-describe the current system in full, to avoid the two files drifting apart.

> **Note:** a second, differently-scoped `client/CLAUDE.md` also exists in this repo (broader product vision doc — different nav list, different priorities, not authored by any Claude Code session). Claude Code loads CLAUDE.md files from both the working directory and its parents, so both are in context when working under `client/`. They haven't been reconciled — check both if something seems inconsistent, and flag it to the user rather than silently picking one.

## ✅ CURRENT BETA STATUS (as of 2026-08-20)

**Closed Coach beta is GO.**

- **Track 1 — manual picker large-file uploads**: still open, separate,
  non-blocking. Fails for very large existing video files (reproduced
  ~508 MiB, ~658 MiB) before the request is observable in Node/Express.
  Root cause unresolved (client/OS-side vs. Render edge/proxy). No
  safe-size boundary for manual iPhone uploads has been established. Was
  already established as not being the reason beta was on hold, and
  remains that way — communicate to beta coaches: prefer the native
  Record flow; manual picker uploads of very large existing files remain
  unreliable.
- **Track 2 — native recording, realistic duration**: **RESOLVED.**
  Validated via N1 (~60s / 6,484,951 bytes, PASS) and N2 (~5min /
  31,758,537 bytes, full end-to-end PASS including confirmed iPhone and
  desktop playback, raw server diagnostic block confirmed). The
  memory-buffering pathway (Point A → IndexedDB → Point B → rebuilt
  Blob) held byte-exact at both scales, the second a realistic
  sideline-replay-length proxy. This was the actual condition blocking
  beta; it's now cleared. Video 399 (~10min / 34,838,966 bytes) adds
  further server-verified upload-endurance evidence at Cresamor's
  largest native-recording upload to date.
- **Native capture-duration ceiling (CONFIRMED, non-blocking)**: a
  ~10-minute native recording (video 399, 34,838,966 bytes) was cut off
  automatically by iOS mid-recording ("maximum length for this video has
  been reached"), while the same device's standalone Camera app does not
  exhibit this cutoff — ruling out a general iPhone limit. Code
  inspection found no explicit duration/size cap anywhere in Cresamor's
  own native capture path (`capture.js`/`index.html`). **Confirmed via a
  bare-HTML isolation test (2026-08-24, RELEASE_NOTES.md)**: a page with
  only `<input type="file" accept="video/*" capture="environment">` and
  zero Cresamor code reproduced the identical ~10-minute cutoff and
  message — this is iOS Safari/WebKit's own native picker component
  (`UIImagePickerController`), not anything in Cresamor's code, and not
  overridable from web content. Does not affect the GO decision or
  Track 2's resolved status — this is a capture-stage limitation separate
  from the already-validated upload/memory pathway. Known limitation to
  communicate: coaches recording continuously beyond ~10 minutes through
  the current native Record flow will hit this. Supporting longer
  continuous recordings (chunked capture, a different invocation,
  stitching multiple captures) is a real future architecture item, not a
  beta blocker — not queued as near-term work.

A 20-minute native-recording test is **not** planned as a near-term beta
task — with the ceiling confirmed as an iOS/WebKit capture-path limit,
that test cannot currently produce a 20-minute payload under the existing
capture path, and there is no further beta-relevant question left for it
to answer.

`RELEASE_NOTES.md`'s 2026-08-20 "Native-recording validation: N1 PASS,
N2 PASS — Track 2 HOLD lifted" entry (including the Video 399 capture-
ceiling subsection) and the 2026-08-19 entry it builds on are
authoritative for all tracks' full evidence — read them before acting,
don't re-derive from commit messages alone.

## What this is

Cresamor: not just a film platform — the product goal (per the project owner) is an athlete's permanent digital sports journey, where profile/teams/film/highlights/messages/calendar/recruiting eventually read as one connected timeline. The MVP today is a sports film-review app: coaches upload game film, athletes/parents watch it, clip highlights, and message. Tagline: "Your Film, Your Way." Deployed on Render as `CresamorFilmRoom-3` (`https://cresamorfilmroom-3.onrender.com`), backed by a free-tier Render Postgres database (`cresamor_db`). See `ARCHITECTURE.md` for the intended Organization → School → Team hierarchy this is being built toward.

## Stack conventions

Plain Node/Express backend (routes organized by resource under `server/routes/`, see `ARCHITECTURE.md`) + vanilla JS/HTML/CSS frontend. **No framework, no bundler, no build step.** New frontend code is added as separate files loaded via `<script>` tags in `client/index.html`, in load order:

```
recordingLibrary.js → app.js → mockData.js → messages.js → home.js → recordingPipeline.js → capture.js → teams.js → invitations.js
```

`teams.js` and `invitations.js` load last, after `capture.js` — same shared-global-scope convention applies.

`recordingLibrary.js` loads *before* `app.js` deliberately — it's the one new frontend file with zero dependency on anything else, and `app.js` itself needs to reference it at its own top level (subscribing the Film Room list to recording-library changes). Every other later file still relies on globals declared by earlier ones (no module system) — e.g. `home.js` uses `apiFetch`, `currentUser`, `filmPlayer`, `selectVideo` from `app.js`, and monkey-patches `window.activateApp`/`window.logoutLocalState` to hook into the login lifecycle without editing `app.js`'s function bodies. Keep this pattern for any new frontend file: don't introduce a bundler or reformat `app.js` into modules without discussing it with the user first — it's a deliberate constraint, not an oversight. (A few narrow, explicitly-documented exceptions exist where `app.js` *was* edited directly: `uploadVideo()` converted to `XMLHttpRequest` for real progress, a blocking `alert()` removed from `loadVideos()`, and the Film Room list becoming a projection over `recordingLibrary` — all explained inline in that file.)

**Gotcha, costs real debugging time if forgotten:** plain (non-module) `<script>` tags share ONE global lexical scope for top-level `const`/`let`/`function`. Two files each declaring `const messageThread = ...` throws `SyntaxError: Identifier has already been declared` and **silently kills the entire second file** (nothing in it runs, no partial execution). `node --check` won't catch this (it doesn't know about sibling scripts' scope) — it only shows up as a browser console error at runtime. Before adding a new top-level name in any client file, check the others first:

```
node -e '
const fs = require("fs");
function topLevelDecls(file) {
  const src = fs.readFileSync(file, "utf8");
  const names = new Set();
  const re = /^(?:const|let|function)\s+([a-zA-Z0-9_$]+)/gm;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}
const files = ["recordingLibrary.js", "app.js", "mockData.js", "messages.js", "home.js", "recordingPipeline.js", "capture.js", "teams.js", "invitations.js"];
const seen = new Map();
for (const f of files) {
  for (const name of topLevelDecls(f)) {
    if (seen.has(name)) console.log(`COLLISION: "${name}" in both ${seen.get(name)} and ${f}`);
    else seen.set(name, f);
  }
}
'
```
(Run from `client/`. This bit the `messages.js` rewrite once — see History below.)

## Known architectural quirks (not bugs to silently "fix")

- **`API_URL` in `client/app.js` is hardcoded to the deployed Render URL, even during local dev.** No local-only mode exists. To test new backend routes before deploying, temporarily point it at `http://localhost:3000`, test, then revert before committing — every route added this project has been verified this way. Full detail in `ARCHITECTURE.md`'s "Deployment reality."
- **JWT verification is real now** (`server/middleware/authenticate.js`, Beta Readiness Sprint 2) — every non-public route requires a valid bearer token, reloads the user fresh from Postgres, and attaches `req.user`. The token payload is deliberately just `{ id }` — don't add fields back into it; email/role must always come from a fresh DB read, not the token, so a role change takes effect immediately instead of waiting out the 7-day expiry. See `ARCHITECTURE.md`'s "Permission model" for the full current state.
- **Video uploads are gated to `role === 'coach'` only client-side**, not server-side. The Record flow (`capture.js`) deliberately doesn't apply this gate at all — athletes recording their own film is the primary use case, and the server never enforced it anyway. Documented product decision, not an oversight.
- **Storage is provider-swappable** (`server/services/storage/` — `storage.js` facade, `localStorage.js`/`r2Storage.js`), picked via `STORAGE_PROVIDER` (defaults to local disk; `r2` for Cloudflare R2 in production). `videos.storage_key`/`users.profile_picture_key` route through the abstraction when set; `file_url`/`profile_picture_url` are legacy-only fields for rows that predate this — don't "clean up" by rewriting them, that's deliberate. Full design and manual Cloudflare setup steps in `ARCHITECTURE.md`'s "Storage strategy."
- **Recordings live in two places by design, not by accident**: IndexedDB (`recordingLibrary.js`, this device's own copy, source of truth) and the `videos` table (the synchronized team-visible copy, once synced). See `ARCHITECTURE.md`'s "Recording pipeline" for the ownership model — don't "simplify" this into a single source without discussing it first, it's what makes offline recording and instant replay work.
- **`server/db/schema.sql` is destructive** (`DROP TABLE`s everything). Never run it against the live database. All schema changes are additive migrations in `server/db/migrations/`, numbered, applied by hand via `psql`, safe to re-run (`IF NOT EXISTS` guards throughout — except one-time backfill `INSERT`s, which are idempotent via `NOT EXISTS`/`ON CONFLICT` but not meant to be a pattern for routine migrations).

## Local development

```
npm install     # node_modules isn't fully committed/current — always run this first
npm run dev     # nodemon server/server.js, serves on localhost:3000
```

Remember: even locally, all API calls go to the live deployed backend by default (see "Known architectural quirks" above).

## History (condensed — see git log and `ARCHITECTURE.md` for full current-state detail)

- **Sprint 1**: Home page (profile block, Hero Card, Featured Reel, Continue Watching, Messages Preview, Upcoming Events, Recent Activity) built against a mix of real data and `mockData.js` placeholders. Recording flow (`capture.js`) built with an upfront Wrestling/Football question → Team/Individual Film choice → device picker → in-browser `MediaRecorder`. Both later revised — see Foundation Sprint below.
- **Sprint 3**: Moved profile fields and the message thread off `localStorage`/hardcoded DOM into real Postgres tables (first real backend phase). Added profile photo upload, Parent account type (no linking yet), Featured Reel's 70/30 desktop layout, real loading/upload progress feedback. `uploadVideo()` converted to `XMLHttpRequest` as the first deliberate exception to "don't edit `app.js`."
- **Foundation Sprint Phase 1**: Real Organization/School/Team hierarchy (replacing free-text `users.team`), FK indexes added project-wide, athlete-profile schema expanded (bio/measurements/goals/social links). `capture.js` switched from `MOCK_TEAMS` to the real `/api/teams`.
- **Foundation Sprint Phase 2**: Real `conversations`/`conversation_participants` schema, replacing the flat single-thread `messages` design (old flat endpoints removed, not kept alongside — avoiding a parallel system). First real server-side permission check in the app (`canAccessConversation`). Caught and fixed a self-introduced regression: the new participant check would have 403'd every newly-registered user, since only pre-existing users were backfilled as participants — fixed via auto-join on registration.
- **Foundation Sprint Phase 3**: Decoupled the upload route from processing — it now responds immediately and transitions `uploading → processing → ready/failed` asynchronously, with a real `GET /api/videos/:id` polling endpoint for clients that care. Previously the route awaited the whole (currently instant, future potentially slow) pipeline before responding.
- **Foundation Sprint Phase 4**: Recording flow rewritten — removed all upfront questions, recording now starts immediately on tap. Team assignment moved to *after* preview. Mobile now hands off to the native OS camera (`<input type="file" capture>`) instead of driving an in-browser recorder, specifically for iOS Safari reliability; desktop keeps the original `MediaRecorder` flow. Confirmed with the user before implementing, since it directly reversed Sprint 1's original recording spec.
- **Foundation Sprint Phase 5**: Documentation pass (this file + `ARCHITECTURE.md`) plus a technical-debt sweep: `server/app.js` (had grown to 680+ lines) split into `server/routes/*.js` by resource; removed a long-standing blocking `alert()` in `loadVideos()` that froze the tab for every first-time athlete; removed `package.json`'s broken-and-dangerous `db:schema` script (pointed at the destructive `schema.sql`).
- **Playback-fix pass**: Root-caused player 404s to Render's ephemeral `/uploads` disk having silently lost two files across a redeploy (`ARCHITECTURE.md`'s "Storage strategy" already flagged this as a risk; this is it happening). Added `available`/`needs_conversion` fields to `GET /api/videos(/:id)` (computed per-request via `fs.existsSync` + file extension, no new column) so the client shows a clear status message and disables Play instead of hitting a decode error. `.MOV` uploads now stay at `processing_status: 'processing'` instead of falsely reaching `'ready'`. Added `DELETE /api/videos/:id` (`canDeleteVideo` in `permissions.js` — uploader or coach) with a Delete control in the Film Library, confirmation dialog, and Home re-render so Featured Highlights/Continue Watching drop a deleted video without a page reload. The two orphaned production rows were deleted through this new endpoint after explicit user confirmation.
- **Real-Time Sideline Replay pass**: Rebuilt the recording pipeline around instant replay instead of fast uploads. New `client/recordingLibrary.js` — an IndexedDB-backed "Recording Library," the single source of truth for every recording this device has captured, local or synced (first use of IndexedDB in this project) — replacing the old pattern of a raw `capture.blob` variable and a blocking full-screen upload step. New `client/recordingPipeline.js` is the one consumer that syncs recordings to the server; it never touches IndexedDB directly, only `recordingLibrary`'s API, and retries via the browser's `online` event plus a reconciliation pass on load (simple v1, not a background-sync worker). `capture.js`'s Review step is now the instant-replay surface itself — no more auto-navigation to Film Room or a blocking "Uploading…/Done" hand-off; the coach keeps watching the local Blob they just recorded while an inline status line tracks `Local → Uploading → Synced → Processed` in place, driven by `recordingLibrary.subscribe()`. The Film Room list in `app.js` became a *projection*: local recordings render (with a lifecycle badge) until `processed`, at which point the server's synced row takes over — the library keeps its own copy either way. `pickSupportedMimeType()` now prefers MP4/H.264 over WebM. Full ownership model (library owns state; pipeline is a subscriber; server is a synchronized view, not the source of truth) in `ARCHITECTURE.md`.
- **Beta Readiness Sprint 1 (Cloudflare R2 migration)**: First Beta Readiness sprint — shifted from feature work to closing gaps before inviting outside testers. Replaced the direct `multer.diskStorage` calls in `videos.js`/`profile.js` with a swappable storage abstraction (`server/services/storage/` — `storage.js` facade, `localStorage.js`, `r2Storage.js`), picked at runtime via `STORAGE_PROVIDER`. New nullable `videos.storage_key`/`users.profile_picture_key` columns (migration `006_r2_storage.sql`) route new uploads through the abstraction; existing rows keep using `file_url`/`profile_picture_url` forever, untouched — no forced migration of old data, by design. Uploads go through a temp file (`uploads/.tmp/`), not an in-memory buffer, so R2 uploads stream via `@aws-sdk/lib-storage`'s `Upload` instead of risking Render's limited RAM on a full video buffer. Optional manual backfill script (`server/scripts/backfillR2.js`) rescues whatever's still actually on disk before it's inevitably lost to a future redeploy — never destructive, never auto-run. Client needed zero changes: `file_url` was already "future-proofed by accident" to just be a string the client resolves the same way regardless of what's behind it. Refined before first push, still pre-deploy: object keys are opaque UUIDs under `videos/{teamId}/{year}/` and `profile-pictures/{userId}/` prefixes — no original filename ever lands in a key; signed URLs shortened to 20 minutes; MIME validation now enforced twice (each route's multer `fileFilter` as a fast-fail first layer, `storage.upload()` itself as the second, both reading the same allowlist off `storage.js` so there's one source of truth, not two lists that can drift). Caught and fixed a real bug during this pass: `needsFormatConversion()` checked `file_url`, which is `NULL` for `storage_key` rows — `.MOV` detection silently never fired for anything uploaded through R2 until this was corrected to check `storage_key` first.
- **Beta Readiness Sprint 2 (server-side authentication & authorization)**: Closed the app's single biggest remaining gap — no route verified the JWT bearer token, so identity was whatever a client claimed. New `server/middleware/authenticate.js` (verifies the token, reloads the user fresh from Postgres, attaches `req.user`) and `server/middleware/authorize.js` (`requireRole`/`requireOwner`/`requireConversationParticipant`, composable and declarative) are now applied across all 21 routes; `permissions.js` gained `canAccessTeam`/`canViewVideo`/`canManageTeamMembership`. JWT payload trimmed to `{ id }` only — email/role are always a fresh DB read. Fixed two real privilege bugs found during the route audit: `GET /api/conversations` returning every conversation when `user_id` was omitted, and `POST /api/users/:id/teams` allowing unauthenticated role escalation to `coach`. Added a DB-backed security audit log (`security_audit_log`, migration `007`) for login/failed-login/deletion/membership-change/rate-limit events; `express-rate-limit` on login/register/upload routes; `helmet()` for standard security headers; environment-driven CORS (`ALLOWED_ORIGIN`) and upload-size limits (`MAX_VIDEO_UPLOAD_MB`/`MAX_PHOTO_UPLOAD_MB`, video default raised well past the old 500MB figure since streaming upload never buffers in memory). Removed the client's free-text "type any username/role" message fields (`client/index.html`) — a real identity-spoofing surface — since the server now derives message identity from the authenticated user. New `server/scripts/testAuth.js` (plain Node, no framework) drives the real app over HTTP and asserts the full acceptance list, cleaning up every row it creates. Full detail in `ARCHITECTURE.md`'s "Permission model."
- **Conversion pipeline OOM stabilization** (2026-08-05): A real production OOM/502 incident converting a mere 10MB phone clip traced to FFmpeg's default thread auto-detection sizing itself off the *host* machine's core count rather than Render's actual 0.5vCPU allocation — reproduced locally against the real file (694MB peak RSS unmodified vs 310MB with `-threads 1`), not file size, which the existing size cap had already ruled out. Fixed with explicit thread pinning (`VIDEO_FFMPEG_THREADS`), an `ffprobe` preflight pass rejecting pathological resolution/frame-rate before FFmpeg ever starts, and explicit `-map` stream selection instead of trusting automatic mapping. Also closed a same-day gap where diagnostic/test code itself corrupted production video rows twice (`ALLOW_PRODUCTION_TESTS` opt-in gate + hard SQL `id = ANY()` scoping on every DB-writing script), and added `repairVideo()`, an admin-only script-only repair path for a stale-error row distinct from the coach-facing `retryConversion()`. Full root cause, before/after measurements, every fix, and current known limitations in `RELEASE_NOTES.md` — the reference for "why are FFmpeg threads pinned to one?"

- **Invitation-accept authorization fix** (2026-08-18, `3190dfb`): opening
  an invitation link while logged into a *different* account silently
  accepted it — token possession alone was checked, not identity.
  Combined with team_members' upsert-on-conflict, a lower-role invite
  could silently overwrite an existing coach's own membership;
  reproduced and repaired in production (`team_members.id=105`). Fixed:
  email invitations now require the authenticated user's server-derived
  email to match the invitation's destination (mismatch → 409, nothing
  consumed); an *active* coach membership can never be silently
  overwritten by a lower-role invite. Client gained an explicit
  confirm-account modal and a distinct mismatch screen.
- **Coach video team reassignment** (2026-08-18, `e5871d2`): new
  `PATCH /api/videos/:id/team`, gated by `canManageTeam()` on *both*
  source and destination team (not `canDeleteVideo()`'s uploader-or-coach
  check) — reassignment changes who can see the video.
- **Final pre-beta authorization audit fixes** (2026-08-18, `1bc6655`) —
  **supersedes the "uploader or coach" `canDeleteVideo` description in
  the Playback-fix pass entry above**: (1) `canDeleteVideo()` (also used
  by retry-conversion/retry-classification) previously let any global
  `role='coach'` user manage *any* video regardless of team. Now:
  uploader always manages their own video; an **assigned** video
  requires `canManageTeam()`; an **unassigned** video keeps the prior
  any-global-coach rule, mirroring `canViewVideo()`'s own null-team-id
  branch. (2) `GET /api/users/:id/teams` and `/clips` had no ownership
  check beyond `authenticate` — fixed with `requireOwner("id")` (already
  proven on `profile.js`).

## Remaining known debt (see `ARCHITECTURE.md`'s "Not yet built" for the full list)

Real video transcoding/thumbnailing; `events`/Calendar and `watch_progress` still mock/local; parent-child linking (and the narrow parent access that results); server-side token revocation (logout is client-side-only); direct browser-to-R2 uploads (still proxied through Express); Messages preview's unread *count* still mocked (only read/unread *state* is real, since Phase 2); chunked/resumable upload during recording (documented future milestone); real background sync (the recording pipeline only retries while the app is open — no service worker); `navigator.storage.persist()` not called, so IndexedDB storage isn't guaranteed to survive disk pressure; coach-editing-an-athlete's-profile; an org-admin role tier above "coach".

## Future direction (recorded, not implemented)

Per the project owner: a single user may eventually hold **different
roles on different teams** — e.g. Coach on a high-school football team,
Athlete on an adult flag-football team, Parent for a child's soccer team,
all on one account. `users.role` today is a single account-wide value;
the direction is toward team/resource relationships
(`team_members.role_on_team`, already the real unit of truth for
`canManageTeam()`/`canAccessTeam()`) increasingly driving access instead
of `users.role` alone. Architectural direction only — no authorization
code should change for this today.
