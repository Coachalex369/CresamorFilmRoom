# Release Notes

Dated, narrative entries for milestones that need more than a CLAUDE.md
history bullet — the kind of thing someone (including future us) will
later ask "wait, why does the code do that?" about. Newest first.

---

## 2026-08-05 — Conversion pipeline OOM: root cause, fix, and verification

**Commits:** `219cfd5`..`2a27faa` (`git log 219cfd5..2a27faa`)

### TL;DR

Production crashed converting a 10MB phone video. The size cap that was
supposed to prevent exactly this kind of incident didn't help, because
file size was never the actual driver — FFmpeg's default thread
auto-detection was. Pinning `-threads 1` cut peak memory from **694MB to
310MB** for the identical file. Verified end-to-end on production
afterward: a fresh real recording converted cleanly, and the original
stuck video converted cleanly too, with health monitored throughout.

### Root cause

Video 78 (`IMG_2161.mov`, a real coach's phone recording, 10,384,787
bytes / 7.5 seconds) was manually retried through `retry-conversion`.
Production immediately started returning sustained, fast `502`s — the
signature of a crashed backend, not a slow/overloaded one. Render
confirmed it was an OOM kill.

The size cap (`MAX_AUTO_CONVERSION_SIZE_BYTES`, 600MB at the time) was
specifically built to prevent this class of incident, and this file was
nowhere near it. That ruled out file size as the cause and meant the
problem was in the FFmpeg invocation itself, not the input.

Diagnosis: downloaded the real video 78 object from R2, installed FFmpeg
locally, and ran the **exact production command** against it —

```
ffmpeg -i input.mov -c:v libx264 -preset veryfast -c:a aac -pix_fmt yuv420p -movflags +faststart -y output.mp4
```

x264's own log line gave it away: `threads=18 lookahead_threads=6` —
auto-detected from the *host machine's* core count. Docker/cgroup
containers commonly report the host's full core count via
`nproc`/`sysconf` even when the container itself is capped to a fraction
of a CPU (Render's instance here is 0.5 vCPU). FFmpeg had no way to know
that, so it sized its per-thread frame/lookahead buffers for a machine it
wasn't actually running on.

### Measurements

Peak process memory, same 10MB file, same machine, only the thread count
changed:

| Command | Peak RSS | |
|---|---|---|
| Unmodified (`threads` unset, x264 auto-detects) | **694 MB** | exceeds a 512MB instance on a 10MB file |
| `-threads 1` + `-x264-params threads=1:lookahead_threads=1` | **310 MB** | comfortable margin |

Measured via `Start-Process` + polling `WorkingSet64` to peak (PowerShell,
Windows) — a proxy for RSS, not identical to Linux `/proc` accounting,
but the ~2.2x reduction from the same input/output is the signal that
matters, not the absolute number on this particular OS.

### Fixes deployed

- **`-threads 1`** (env: `VIDEO_FFMPEG_THREADS`), applied both as the
  top-level FFmpeg option and explicitly via `-x264-params
  threads=1:lookahead_threads=1` — no ambiguity about which stage picks
  it up. (`2a27faa`)
- **`-map 0:v:0 -map 0:a:0?`** — explicit stream selection instead of
  trusting FFmpeg's automatic mapping heuristic. Didn't change behavior
  for this specific file (auto-mapping already happened to drop its two
  iPhone Cinematic-mode metadata streams correctly) but makes the encode
  input deterministic across whatever phones/cameras upload next, rather
  than depending on a heuristic that could pick differently for a
  different container. The trailing `?` makes the audio map optional, so
  a video-only source doesn't error. (`2a27faa`)
- **`runPreflightProbe()`** — a new `ffprobe` pass that runs before
  FFmpeg starts. Rejects missing/unreadable video streams and anything
  over 3840×2160 or 60fps (env: `VIDEO_PREFLIGHT_MAX_WIDTH` /
  `_HEIGHT` / `_FPS`). Failure messages are prefixed by stage, so
  `processing_error` shows what was actually probed instead of a bare
  exit code. (`2a27faa`)
- **Structured per-attempt logging** (`video_conversion_attempt`):
  outcome, duration, peak RSS (best-effort via `/proc/<pid>/status` on
  Linux, `null` elsewhere), and the full probe result. Not a metrics
  table yet — console output only — but the foundation for spotting
  patterns as beta uploads get more varied. (`2a27faa`)
- **Startup recovery made size-aware** (this was the fix immediately
  before the OOM — the boot-time requeue that caused the *original*
  incident had been disabled outright; replaced with a version that
  re-checks size, recovers orphaned `'converting'` *and* `'queued'` rows
  (grace-period gated so it can't race a fresh upload), and is gated
  behind `NODE_ENV=production && STORAGE_PROVIDER=r2` so it can never run
  for real against local/dev storage). (`219cfd5`, `e22dffd`)
- **`retry-conversion` made size-aware** — it used to always attempt
  conversion regardless of size; a manual retry of the 685MB wrestling
  video through this exact gap is what caused the OOM that started this
  investigation in the first place. (`0787a26`)
- **Two independent safety layers for test code**, after test code
  itself corrupted production video state twice during this
  investigation: `ALLOW_PRODUCTION_TESTS=true` opt-in gate on every
  DB-writing script, and hard `id = ANY($1)` SQL scoping so a test can
  only ever touch rows it created itself — structural, not just an
  environment check. (`f83f7a1`)
- **`repairVideo()`** — an admin-only, script-only (never an HTTP route)
  repair path for a row whose `processing_error` is stale rather than a
  real conversion failure. Deliberately separate from `retryConversion()`
  (the coach-facing endpoint). Refuses to run outside the real production
  R2 environment, since `storage.exists()` is provider-aware and would
  silently check the wrong filesystem otherwise. (`28c3d71`)
- **`live_size_bytes`** on `GET /api/videos/:id` — a real-time
  `storage.getObjectSize()` call, added specifically to answer "how big
  is this file, actually" without needing R2 credentials or shell access
  to production. (`7799bbd`)

### Production verification

Four phases, in order, each gating the next:

1. **Deploy + stability** — health `200` for a full 5.5-minute window
   post-deploy, videos 42/78 held at `deferred`, zero automatic recovery
   activity.
2. **Fresh recording, real conversion** — a genuinely new recording
   (captured in-browser via canvas + MediaRecorder, uploaded through the
   real API) went `uploading → queued → converting → ready` with no
   retry and no errors, exercising the full new pipeline including the
   optional-audio `-map` path (this clip had no audio track).
3. **Cross-device** — appeared immediately on a second, independent
   session; survived a refresh; real playback confirmed (not just API
   state) on both sessions.
4. **Video 78 itself** — `retry-conversion` on the actual video that
   started this incident: `deferred → queued → converting → ready` in
   seconds, health stayed `200` throughout, video 42 (654MB, genuinely
   over the cap) stayed untouched at `deferred` the entire time.

### Current known limitations

- **The Linux OOM killer's target isn't guaranteed.** Bounding FFmpeg's
  memory makes it overwhelmingly the larger process in this container, so
  it's far more likely to be the one killed if memory pressure recurs —
  but that's a probability argument, not a guarantee that Node itself can
  never be selected.
- **Temp-file cleanup relies on graceful completion.** `convertVideo()`'s
  cleanup runs in a `finally` block; a hard `SIGKILL` (a real OOM kill)
  skips it entirely, leaving `input`/`output` files on disk. Not a memory
  cause, just accumulating debris across repeated crashes — not yet
  addressed.
- **`MAX_AUTO_CONVERSION_SIZE_BYTES` (600MB) hasn't been revisited.**
  It's still a legitimate guard for genuinely huge files, but this
  incident proved it was never sufficient on its own — a file 60x smaller
  than the cap caused the crash. No evidence yet on what the *right*
  number is now that threads are bounded.
- **Peak-RSS logging only works in the real environment.** `/proc/<pid>/status`
  is Linux-only; local Windows dev always logs `peakRssMb: null`. The
  PowerShell measurements above were a one-time manual diagnostic, not
  something the app does automatically.
- **Preflight bounds (3840×2160, 60fps) are conservative defaults, not
  empirically tuned.** They were chosen to comfortably fit phone footage,
  not derived from measuring what this instance can actually sustain at
  various resolutions.
- **No persistent metrics table yet.** `video_conversion_attempt` log
  lines exist; nothing aggregates them. Spotting patterns today means
  reading logs by hand.
