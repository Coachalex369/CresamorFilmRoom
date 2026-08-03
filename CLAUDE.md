# Cresamor Film Room — CLAUDE.md

Guidance for future Claude Code sessions working in this repo.

## What this is

A sports film-review MVP: coaches upload game film, athletes/parents watch it, clip highlights, and message. Tagline: "Your Film, Your Way." Deployed on Render as `CresamorFilmRoom-3` (`https://cresamorfilmroom-3.onrender.com`), backed by a free-tier Render Postgres database (`cresamor_db`).

## Stack

Plain Node/Express backend + vanilla JS/HTML/CSS frontend. **No framework, no bundler, no build step.** Static files served directly via `express.static`. New frontend code is added as separate files loaded via `<script>` tags in `client/index.html`, in load order:

```
app.js → mockData.js → home.js → capture.js
```

Later files rely on globals declared by earlier ones (no module system) — e.g. `home.js` uses `apiFetch`, `currentUser`, `filmPlayer`, `selectVideo` from `app.js`, and monkey-patches `window.activateApp`/`window.logoutLocalState` to hook into the login lifecycle without editing `app.js` itself. Keep this pattern for any new frontend file: don't introduce a bundler or reformat `app.js` into modules without discussing it first — it's a deliberate constraint, not an oversight.

## Known architectural quirks (not bugs to silently "fix")

- **`API_URL` in `client/app.js` is hardcoded to the deployed Render URL**, even during local dev. Running `npm run dev` locally serves the HTML/CSS/JS from `localhost:3000`, but every `apiFetch` call (including login/register) still hits the real deployed backend and the real live database. There is no "local-only" mode — be careful with writes during local testing.
- **No JWT verification middleware exists anywhere.** Routes trust a client-supplied `user_id`/`uploaded_by` in the request body rather than checking the bearer token server-side. Login/register issue real JWTs, but nothing currently verifies them. Any new endpoint should not assume this is fixed.
- **Video uploads are gated to `role === 'coach'` only client-side** (in `uploadVideo()` in `app.js`) — the server route (`POST /api/upload-video`) does not enforce this itself. The new Record flow (`capture.js`) deliberately does **not** apply this same gate, since Sprint 1 is athlete-first (athletes recording their own film is the primary use case) and the server never enforced it anyway. This is a documented product decision, not an oversight — flag it if it needs revisiting.
- **`loadVideos()` in `app.js` calls a blocking native `alert()`** when the video list is empty ("No videos found in database."). This will fire for every first-time athlete (since only coaches can upload through the old flow), and blocking `alert()`s freeze the whole tab for browser automation tools. Worth fixing in a follow-up; not touched this session since it's outside the approved Phase 1/2 file scope.
- **`uploads/` is local disk storage**, wiped on every Render redeploy/restart (free tier has no persistent disk). Not addressed.
- **`server/db/schema.sql` is destructive** — it `DROP TABLE`s `clips`/`videos`/`users` before recreating them. Never re-run it against the live database; any future schema change should be a new additive migration file instead (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- **`package.json`'s `db:schema` script** (`psql $env:DATABASE_URL -f server/db/schema.sql`) is PowerShell syntax (`$env:`) and will not work as-is in bash.

## Database

Postgres, 3 tables: `users` (id, email, password_hash, role — CHECK constrained to `'coach'`/`'athlete'` only, no `'parent'`), `videos` (id, title, file_url, uploaded_by, created_at), `clips` (id, title, start_time, end_time, video_id, user_id, created_at). No teams, messages, events, activity-log, or watch-progress tables exist — see "Sprint 1 Phase 1/2" below for how the current UI works around that.

## Sprint 1 (Phase 1 + Phase 2) — what was added

**Phase 1 — Home page + navigation**, entirely frontend, no schema/backend changes:
- `client/home.js` — Home screen: profile block, Hero Card, Featured Highlight Reel (auto-rotating, client-side-generated thumbnails via hidden `<video>` + `<canvas>`), Continue Watching, Messages Preview, Upcoming Events, Recent Activity.
- `client/mockData.js` — **the only file with fake data.** Every export is prefixed `MOCK_` and is a stand-in for a backend that doesn't exist yet (events/calendar, coach notifications, teams, activity fallback). Grep this file first when a real backend for these lands — swap the `MOCK_*` usages in `home.js`/`capture.js` for real `apiFetch` calls.
- Nav expanded to Home/Film/Highlights/Messages/Calendar/Teams/Profile/Settings. Home is now the default screen. Calendar/Teams/Profile/Settings are minimal placeholders.
- Dark/gold theme: new CSS variables `--gold`/`--gold-soft`/`--gold-dim` in `client/index.css`, applied to the new Home/nav/capture-modal UI. The original teal `--accent` is left as-is on the pre-existing Film/Highlights/Messages/drawing-tool UI — deliberately not globally reskinned.
- Real data used where possible: new-highlights count (clips in the last 7 days) and Recent Activity's real entries come from the existing `/api/videos` and `/api/users/:id/clips` endpoints. Continue Watching is `localStorage`-only (throttled `timeupdate` listener on `#film-player`). Profile fields (picture/school/team/grad year) have no DB column yet — stored as `localStorage` overrides (`cresamor_profile_overrides`), clearly labeled in the UI as device-only.

**Phase 2 — Recording capability**, browser APIs only, no new dependencies:
- `client/capture.js` — a "🎥 Record Film" button (visible to all roles, next to the existing coach-only manual upload) opens a modal state machine: context-aware Wrestling/Football assumption (read from `localStorage.cresamor_last_recording_context`) → Team Film/Individual Film + team picker (from `MOCK_TEAMS`) → device selection (`enumerateDevices`, covers phone/USB/webcam uniformly) → `MediaRecorder` record/pause/resume/stop → review/discard → upload via `XMLHttpRequest` (for real progress events) to the existing, unmodified `POST /api/upload-video`.
- Compression strategy: capture-time only — `getUserMedia` capped at 720p + `MediaRecorder({ videoBitsPerSecond: 2_500_000 })`. No ffmpeg, no post-processing pass, no deployment changes.
- `film_type`/team choice **cannot be persisted server-side** without a schema change (out of scope this session) — folded into the uploaded video's `title` string instead (e.g. "Individual Film — Cresamor Wrestling — 8/3/2026, 3:00 PM"). Documented limitation, not a bug.
- The existing manual file-picker upload (`#video-upload`, coach-only) is completely untouched and remains available as a fallback.

## Next backend phase (deferred, not dropped)

A real backend phase would add (additively, no drops): `teams`/`user_teams`, `conversations`/`messages`/`conversation_participants`, `events`, `comments`, `watch_progress` tables, plus `profile_picture_url`/`school`/`graduation_year` on `users` and `film_type`/`team_id` on `videos`, and widen the `role` CHECK to include `'parent'`. See git history around the Sprint 1 commit for the fuller original schema proposal if useful context.

## Local development

```
npm install     # node_modules isn't fully committed/current — always run this first
npm run dev     # nodemon server/server.js, serves on localhost:3000
```

Remember: even locally, all API calls go to the live deployed backend (see "Known architectural quirks" above) — there is no way to point this app at a local database without editing `API_URL` in `client/app.js`.
