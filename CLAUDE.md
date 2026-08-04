# Cresamor Film Room — CLAUDE.md

Guidance for future Claude Code sessions working in this repo.

**For current architecture** (data model, permission model, video pipeline, storage migration path, deployment reality) **see `ARCHITECTURE.md`.** This file is session guidance: conventions, gotchas that cost real debugging time, and a condensed history of what changed and why — it intentionally doesn't re-describe the current system in full, to avoid the two files drifting apart.

> **Note:** a second, differently-scoped `client/CLAUDE.md` also exists in this repo (broader product vision doc — different nav list, different priorities, not authored by any Claude Code session). Claude Code loads CLAUDE.md files from both the working directory and its parents, so both are in context when working under `client/`. They haven't been reconciled — check both if something seems inconsistent, and flag it to the user rather than silently picking one.

## What this is

Cresamor: not just a film platform — the product goal (per the project owner) is an athlete's permanent digital sports journey, where profile/teams/film/highlights/messages/calendar/recruiting eventually read as one connected timeline. The MVP today is a sports film-review app: coaches upload game film, athletes/parents watch it, clip highlights, and message. Tagline: "Your Film, Your Way." Deployed on Render as `CresamorFilmRoom-3` (`https://cresamorfilmroom-3.onrender.com`), backed by a free-tier Render Postgres database (`cresamor_db`). See `ARCHITECTURE.md` for the intended Organization → School → Team hierarchy this is being built toward.

## Stack conventions

Plain Node/Express backend (routes organized by resource under `server/routes/`, see `ARCHITECTURE.md`) + vanilla JS/HTML/CSS frontend. **No framework, no bundler, no build step.** New frontend code is added as separate files loaded via `<script>` tags in `client/index.html`, in load order:

```
app.js → mockData.js → messages.js → home.js → capture.js
```

Later files rely on globals declared by earlier ones (no module system) — e.g. `home.js` uses `apiFetch`, `currentUser`, `filmPlayer`, `selectVideo` from `app.js`, and monkey-patches `window.activateApp`/`window.logoutLocalState` to hook into the login lifecycle without editing `app.js`'s function bodies. Keep this pattern for any new frontend file: don't introduce a bundler or reformat `app.js` into modules without discussing it with the user first — it's a deliberate constraint, not an oversight. (Two narrow, explicitly-documented exceptions exist where `app.js` *was* edited directly: `uploadVideo()` converted to `XMLHttpRequest` for real progress, and one blocking `alert()` removed from `loadVideos()` — both explained inline in that file.)

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
const files = ["app.js", "mockData.js", "messages.js", "home.js", "capture.js"];
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
- **No JWT verification middleware exists anywhere** — the single biggest gap between this app and a production-ready one. See `ARCHITECTURE.md`'s "Permission model" for the current partial state (one real check exists: conversation participancy) and the intended shape.
- **Video uploads are gated to `role === 'coach'` only client-side**, not server-side. The Record flow (`capture.js`) deliberately doesn't apply this gate at all — athletes recording their own film is the primary use case, and the server never enforced it anyway. Documented product decision, not an oversight.
- **`uploads/` is local disk storage**, ephemeral on Render's free tier. Migration path to object storage is fully documented (not implemented) in `ARCHITECTURE.md`.
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

## Remaining known debt (see `ARCHITECTURE.md`'s "Not yet built" for the full list)

JWT server-side verification (largest gap); real video transcoding/thumbnailing; `events`/Calendar and `watch_progress` still mock/local; parent-child linking; object storage migration (documented, not implemented); Messages preview's unread *count* still mocked (only read/unread *state* is real, since Phase 2).
