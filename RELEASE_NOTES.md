# Release Notes

Dated, narrative entries for milestones that need more than a CLAUDE.md
history bullet — the kind of thing someone (including future us) will
later ask "wait, why does the code do that?" about. Newest first.

---

## 2026-08-20 — Native-recording validation: N1 PASS, N2 PASS — Track 2 HOLD lifted

**Track 2 (native recording, realistic duration) is now resolved: both
validation-ladder rungs run so far — N1 (~60s) and N2 (~5min) — passed
with full, matching client- and server-side evidence, including
confirmed playback on both iPhone and desktop for N2. Closed Coach beta
moves from ON HOLD to GO as a result. Track 1 (manual picker large-file
uploads) is untouched by this and remains a separate, open, non-blocking
limitation — see the 2026-08-19 entry below.**

### N1 — ~60-second native recording: PASS

#### Identifiers

- Test: 8/20/26 N1 Test 1
- File: `80894966770__AFF08993-6840-4E5D-BFD7-8EE968D5B688.MOV`
- Size: 6,484,951 bytes (~6.2 MiB)
- MIME: `video/quicktime`
- `recordingId`: `a5175ef3-515c-42de-8ecd-c8bdde81da10`
- Server video id: `397`

#### Client evidence

- Native picker returned the recording successfully.
- POINT A verified the complete file at 6,484,951 bytes.
- IndexedDB storage succeeded.
- POINT B verified the file remained 6,484,951 bytes after the IndexedDB
  round-trip.
- The rebuilt upload Blob remained exactly 6,484,951 bytes.
- XHR upload proceeded without stalling; server returned HTTP 201.
- Recording pipeline outcome = `success`; phone UI progressed through
  syncing to `Synced ✓`.
- Cross-device visibility confirmed: the Aug 20 phone-tested recording
  appeared and was visible on the laptop.

#### Independent server evidence (Render logs, raw)

```
[UPLOAD DIAGNOSTIC] multer started
[UPLOAD DIAGNOSTIC] multer completed successfully
[UPLOAD DIAGNOSTIC] req.file: fieldname=video originalname=80894966770__AFF08993-6840-4E5D-BFD7-8EE968D5B688.MOV mimetype=video/quicktime size=6484951
[UPLOAD DIAGNOSTIC] storage/R2 upload started
[UPLOAD DIAGNOSTIC] storage/R2 upload completed
[UPLOAD DIAGNOSTIC] DB insert started
[UPLOAD DIAGNOSTIC] DB insert completed: video id=397
[UPLOAD DIAGNOSTIC] processing/classification enqueue started
[UPLOAD DIAGNOSTIC] response 201 sent
POST /api/upload-video 201 7030.157 ms - 448
```

Client-reported and server-reported sizes match exactly (6,484,951 bytes)
at every checkpoint — no truncation or corruption anywhere across the
Point A → IndexedDB → Point B → rebuilt-Blob → XHR → Multer chain. This
was the first real (non-trivial) control, replacing the original ~670 KB
positive control (a few seconds of footage).

### N2 — ~5-minute native recording: FULL END-TO-END PASS

#### Identifiers

- Test: N2, 8/20/26
- Team: Griffins
- Date/time: 8/20/2026, ~7:37 PM
- File: `80896875613__436BC144-C69F-4FC3-9027-5B0AA11CAC1A.MOV`
- Duration: ~5 minutes (user-confirmed directly; not inferred from debug
  timestamps)
- Size: 31,758,537 bytes (~30.3 MiB)
- MIME: `video/quicktime`
- `recordingId`: `0cc4310c-9032-4ffb-bc5c-46fd263efa61`
- Server video id: `398`
- `team_id`: `32`
- R2 storage key: `videos/32/2026/73e0cf82-ba09-4f36-a466-31942f933d5a.mov`

#### Client evidence

- Native picker returned the recording successfully.
- POINT A verified the complete file at 31,758,537 bytes.
- IndexedDB storage succeeded.
- POINT B verified the file remained 31,758,537 bytes after the
  IndexedDB round-trip.
- The rebuilt upload Blob remained exactly 31,758,537 bytes.
- No truncation or corruption anywhere across the Point A → IndexedDB →
  Point B → rebuilt-Blob chain, at ~4.9× N1's payload size.
- XHR upload proceeded; first recorded progress `131072 / 31,758,992`
  (the 455-byte delta from the raw payload is multipart form overhead,
  not a size mismatch).
- HTTP 201 returned; recording pipeline outcome = `success`.
- iPhone playback: **PASS** — video 398 played successfully on the
  iPhone.
- Laptop appearance: **PASS** — video 398 appeared on the laptop after
  refresh.
- Laptop playback: **PASS** — video 398 played successfully on the
  laptop (confirmed as a separate fact from appearance).

#### Independent server evidence (Render logs, raw)

```
[UPLOAD DIAGNOSTIC] multer started
[UPLOAD DIAGNOSTIC] multer completed successfully
[UPLOAD DIAGNOSTIC] req.file: fieldname=video originalname=80896875613__436BC144-C69F-4FC3-9027-5B0AA11CAC1A.MOV mimetype=video/quicktime size=31758537
[UPLOAD DIAGNOSTIC] storage/R2 upload started
[UPLOAD DIAGNOSTIC] storage/R2 upload completed
[UPLOAD DIAGNOSTIC] DB insert started
[UPLOAD DIAGNOSTIC] DB insert completed: video id=398
[UPLOAD DIAGNOSTIC] processing/classification enqueue started
[UPLOAD DIAGNOSTIC] response 201 sent
POST /api/upload-video 201 15956.954 ms - 440
```

Client-reported and server-reported sizes match exactly (31,758,537
bytes) at every checkpoint. Correct team association (Griffins /
team_id 32) and a real, correctly-scoped R2 storage key confirm the full
server-side chain — Multer receipt, R2 upload, DB insert, team scoping —
executed correctly, not merely that some 201 was returned from
somewhere.

Minor corroborating detail: `GET /api/videos` response payload size
increased from ~9,345 bytes to 10,333/10,377 bytes in the surrounding
log window, consistent with video 398 becoming part of the returned
collection.

#### Bitrate (computed, not assumed)

31,758,537 bytes over ~5 minutes (300s) ≈ 0.85 Mbps — close to N1's
computed ~0.86 Mbps (6,484,951 bytes / 60s). Noted because it's a real,
derived figure from two now-independently-confirmed durations, not
because two data points establish a general rate: this may reflect this
specific device's camera defaults rather than a property of native
recording in general. Do not generalize this bitrate beyond this
device/test pairing.

#### Network condition (anecdotal, not a controlled benchmark)

This test was run with the iPhone off Wi-Fi (cellular). The upload
completed successfully, and was reported as faster than prior
Wi-Fi-connected uploads. This is useful real-world evidence that a
~30.3 MiB native recording can complete without Wi-Fi, and suggests file
size alone doesn't explain some previously-observed slow uploads. It is
**not** a controlled cellular-vs-Wi-Fi benchmark — do not conclude
cellular is inherently faster, or that home Wi-Fi caused earlier
problems, from this single observation.

### Track 2 status: HOLD LIFTED

N1 and N2 together replace the original trivial ~670 KB control with two
real, byte-verified, increasingly realistic controls — the second at a
genuine sideline-replay-length proxy (~5 minutes) — with zero corruption
anywhere in the memory-buffering pathway (Point A / IndexedDB / Point B /
rebuilt Blob) at any scale tested, and full confirmed end-to-end success
including playback on both iPhone and desktop. The specific risk that
justified the original HOLD (this file's 2026-08-19 entry: an untested
duration-sensitive triple in-memory materialization) has been directly
tested and cleared.

**Closed Coach beta: GO**, effective 2026-08-20. Track 1 (manual picker
large-file uploads, still open, see the 2026-08-19 entry below) was
already established as not being the reason beta was on hold, and
remains a separate, documented, non-blocking limitation — communicate to
beta coaches per the existing guidance (prefer the native Record flow;
manual picker uploads of very large existing files remain unreliable).

### Optional future validation (not prerequisites for GO)

10-minute and 20-minute native recordings are planned as additional
endurance/headroom testing. These are follow-up checks beyond the
realistic-proxy threshold this gate was built around, not conditions for
the GO decision above. If either surfaces a new issue, treat it as a new,
separate finding — not a reopening of this entry's conclusion by default.

### Video 399 — ~10-minute native recording: upload endurance PASS; capture-duration ceiling discovered (unresolved)

**Two separate findings, kept distinct.** (1) A genuine, fully
server-verified endurance result: a ~10-minute native recording
completed the full Cresamor upload pipeline successfully, with raw
Render evidence matching N1/N2's rigor. (2) A new, previously
undocumented limitation: the recording did not run for as long as the
user intended — iOS stopped it automatically at ~10 minutes. These are
not the same finding and must not be conflated.

#### Identifiers

- Test: ~10-minute native endurance test, 8/20/26
- File: `80897245641__063EF9D3-1FBD-4689-B7FF-5329E0BFDA32.MOV`
- Duration: ~10 minutes (the recording ran until iOS auto-stopped it —
  see "Capture-duration cutoff" below)
- Size: 34,838,966 bytes (~33.2 MiB)
- MIME: `video/quicktime`
- Server video id: `399`

#### Server evidence (Render logs, raw)

```
[UPLOAD DIAGNOSTIC] multer started
[UPLOAD DIAGNOSTIC] multer completed successfully
[UPLOAD DIAGNOSTIC] req.file: fieldname=video originalname=80897245641__063EF9D3-1FBD-4689-B7FF-5329E0BFDA32.MOV mimetype=video/quicktime size=34838966
[UPLOAD DIAGNOSTIC] storage/R2 upload started
[UPLOAD DIAGNOSTIC] storage/R2 upload completed
[UPLOAD DIAGNOSTIC] DB insert started
[UPLOAD DIAGNOSTIC] DB insert completed: video id=399
[UPLOAD DIAGNOSTIC] processing/classification enqueue started
[UPLOAD DIAGNOSTIC] response 201 sent
POST /api/upload-video 201 26418.534 ms - 449
```

This confirms the full server chain — Multer receipt → R2 upload → DB
insert → classification enqueue → HTTP 201 — completed successfully for
the exact 34,838,966-byte payload, Cresamor's largest confirmed
native-recording upload to date.

Corroborating-only detail: the surrounding `/api/videos` response
payload size increased from 7,279 bytes before upload to 8,284/8,336
bytes afterward, consistent with video 399 entering the returned
collection. Not treated as load-bearing evidence on its own.

Note: unlike N1 and N2, client-side Point A / Point B / rebuilt-Blob
byte-integrity checks were not supplied for this recording in the
evidence gathered so far — only server-side confirmation is recorded
here. If that client-side evidence becomes available later, add it to
this entry rather than assuming it matches N1/N2's pattern.

#### Size observation (measured only, not extrapolated)

34,838,966 bytes (~10 min) is only modestly larger than N2's 31,758,537
bytes (~5 min), despite roughly double the duration. This is recorded as
a measured fact, not used to infer a general duration-to-size rate —
content, motion, and lighting materially affect video bitrate, and
extrapolating a linear relationship from three data points across
different recordings would overstate what's actually known. Do not use
this to predict the size of a future longer recording.

#### Independent confirmation this isn't a general iPhone limit

The user independently tested ordinary recording using the iPhone's
normal Camera app (outside Cresamor entirely) and confirmed it does
**not** automatically stop at ~10 minutes. This rules out "this is just
how iPhone video recording works" as an explanation — whatever is
causing the cutoff is specific to how the recording was initiated, not a
property of the device or iOS video recording in general.

#### What happened (capture cutoff)

video 399 was intentionally run as the ~10-minute native endurance test.
Partway through, iOS automatically stopped the recording and displayed:

> "Video Recording Stopped. The maximum length for this video has been
> reached."

#### Code inspection: no explicit limit in Cresamor's code

The native capture path was inspected end to end (`client/capture.js`,
`client/index.html`). The relevant element:

```html
<input type="file" id="capture-native-input" accept="video/*" capture="environment" class="hidden" />
```

`capture.js` only toggles the `capture` attribute between
`"environment"` and `"user"` and programmatically clicks this input —
there is no JS `MediaRecorder` involved in the iPhone path at all (that
only exists in the separate desktop branch of the same file). No
`600`-second, 10-minute, maximum-duration, maximum-file-size, or
equivalent constant, attribute, or setting was found anywhere in
`capture.js`, `index.html`, or any related client file.

#### Current classification (leading explanation, not yet proven)

**Capture-flow-specific cutoff, likely iOS/WebKit behavior associated
with `<input type="file" accept="video/*" capture>`, not a
Cresamor-configured duration limit.** The `capture` attribute is
understood to invoke a native picker component (on iOS, backed by
`UIImagePickerController` in camera mode) that is architecturally
distinct from the standalone Camera app, with its own separate default
behavior that web content has no attribute or API to configure either
way. This component is widely believed to carry a default video-duration
ceiling around 10 minutes when a hosting app doesn't override it —
Cresamor's markup has no mechanism to override it even if it wanted to,
since no such mechanism is exposed to web content.

**This is the leading explanation, not an established fact.** Do not
treat `UIImagePickerController`'s `videoMaximumDuration` default as
confirmed until the isolation test below actually reproduces the
behavior outside Cresamor entirely.

#### Isolation test (proposed, not yet run)

A standalone HTML page containing essentially only:

```html
<input type="file" accept="video/*" capture="environment">
```

— no Cresamor code, no other markup — opened directly in iOS Safari,
recording continuously past 10 minutes.

- **If it stops at ~10 minutes with the same "maximum length" message**:
  isolates the ceiling entirely outside Cresamor's code and strongly
  establishes it as an iOS/WebKit capture-path behavior tied to the
  `capture` attribute itself.
- **If it records past 10 minutes**: the current theory is falsified or
  incomplete, and investigation returns to Cresamor's specific
  invocation/context.

#### Effect on beta status

**Does not reverse Closed Coach beta = GO.** N1 and N2 already cleared
the Track 2 upload/memory-buffering gate (byte-exact integrity at
~6.2 MiB/~60s and ~30.3 MiB/~5min, full end-to-end PASS with playback on
iPhone and desktop for N2). Video 399 adds further server-verified
endurance evidence that the upload pipeline itself holds at ~10 minutes
and ~33.2 MiB. The newly discovered capture-duration ceiling is a **new,
separate, capture-stage limitation** — not evidence that the previously
validated upload/memory pathway failed, and not grounds to reopen that
decision.

**Document prominently as a known limitation regardless**: coaches
attempting a single continuous native recording longer than ~10 minutes
through the current Record flow may hit this cutoff. This should be
communicated the same way Track 1's manual-picker limitation already is.

#### Effect on the planned 20-minute test

**Do not run a 20-minute native-recording test as the next
upload-endurance step under the current capture path** — if the capture
UI itself enforces a ~10-minute ceiling, that test cannot currently
produce a 20-minute payload to test against regardless of upload/pipeline
readiness. Sequence is:

1. Run the bare-HTML isolation test above first.
2. If confirmed as an iOS/WebKit capture-path ceiling, separately
   evaluate architectural options for supporting longer continuous
   recordings (e.g., chunked capture, a different capture invocation,
   stitching multiple captures) as its own future task — **not
   undertaken as part of this documentation entry**.

---

## 2026-08-19 — OPEN: iPhone video upload reliability — two separate, unresolved tracks

**Do not conflate these.** Both concern uploading video from an iPhone,
but they are different code paths with different evidence and different
status.

### Track 1 — Manual picker large-file investigation (unresolved)

Manual picker uploads (`#video-upload` → `uploadVideo()` in `client/app.js`
— the "choose an existing video" path) of very large existing video files
fail client-side with an XHR `error` event (no HTTP status) ~10-30s in.
Reproduced twice:

| File | Size | Elapsed to failure |
|---|---|---|
| `IMG_0551.mov` | ~658 MiB | ~9.7s |
| `IMG_0552.mov` | ~508 MiB | ~28.4s |

Matching Render logs both times: normal app traffic present, but no
`POST /api/upload-video` and no `[UPLOAD DIAGNOSTIC] multer started` —
the request left no observable footprint in Node/Express either time.

Rules out (reasonably confidently): Multer's size limit, busboy parsing,
the route handler, R2, DB insert, classification/conversion,
`MAX_AUTO_CONVERSION_SIZE_BYTES` (only gates the dormant legacy
full-transcode retry path), and any mutation of the source file by
Cresamor's code (`uploadVideo()` only performs read-only
`FormData.append`/`xhr.send`).

`IMG_0552.mov` — confirmed healthy in Photos both around the attempt and
afterward — reproduces the identical failure, ruling out "the source
asset is corrupted/unhealthy" as a *necessary* explanation. (`IMG_0551.mov`
was deleted before a before/after baseline could be established; it must
not be cited as evidence of anything Cresamor did to it, in either
direction.)

Unresolved boundary: iOS/WebKit/File Provider large-file export/streaming
behavior vs. Render edge/proxy behavior — Cresamor has no visibility into
Render's own edge/proxy logs, only its own application logs. No specific
Render size/timeout limit is documented anywhere Render publishes; do not
assume one. No safe-size threshold has been established — do not quote one.

**Next diagnostic (blocked, not run)**: a live-observed manual upload of a
brand-new disposable recording with Safari Web Inspector attached (iPhone
+ Mac via cable), to see whether bytes actually leave the device before
the failure. Requires a Mac; current dev machine is Windows. Parked until
available.

**Scope**: this track is specific to the manual file-picker path.
`client/capture.js` and `client/recordingPipeline.js` (native recording)
are untouched and not implicated by this track's evidence.

### Track 2 — Native recording beta gate (NOT YET VALIDATED — beta HOLD)

The only confirmed-successful native-recording control is a ~670 KB clip
(HTTP 201, video id 394) — almost certainly a few seconds of footage. That
proves the endpoint/pipeline wiring works for a trivial payload. It does
**not** establish that a coach can reliably record and sync realistic
game-film lengths (1+ minutes).

Reason this needs dedicated validation, not just an assumption of "it
works": the fix behind that positive control
(`client/recordingPipeline.js:54-89`) resolves a real, previously
root-caused bug (busboy "Unexpected end of form" — an IndexedDB-backed
Blob reference failing under XHR's streaming read) by reading the
recording's full byte content into memory three separate times across its
lifecycle: once transiently in `capture.js` (Point A, `.arrayBuffer()` —
result not retained, almost certainly GC'd before upload time), once in
`recordingPipeline.js` (Point B, `.arrayBuffer()` — the resulting
`ArrayBuffer` IS retained, referenced for the entire remaining upload),
and once more when that `ArrayBuffer` is used to construct a new `Blob`
(`new Blob([pointBBuffer], ...)`) — the object actually handed to
`xhr.send()`. Of these three, at least two (the retained `ArrayBuffer` and
the `Blob` built from it) are provably resident in memory simultaneously
for the full duration of the upload, since the `ArrayBuffer` is never
released. This entry deliberately doesn't claim a specific peak-RAM
multiplier beyond that — whether the original IndexedDB-sourced `Blob`
reference also corresponds to concurrently-resident bytes at that same
moment depends on the browser's internal Blob storage implementation,
which isn't verifiable from the application source alone.

This is a reasonable tradeoff at trivial size and untested at real size.
Native recordings also bypass Cresamor's own bitrate cap entirely: the
`videoBitsPerSecond: 2_500_000` cap set in `capture.js`'s
`captureRecordBtn` click handler only applies to the desktop in-browser
`MediaRecorder` path. The native mobile path hands off to the iPhone's own
camera app via `<input type="file" capture>` (`captureNativeInput` in
`capture.js`) and receives back whatever file the OS camera produces —
Cresamor has no bitrate/resolution control over it at all. A native
recording's real-world size is therefore governed entirely by the
iPhone's own camera defaults, outside Cresamor's control, and unknown
today.

This does **not** mean native recording is known-broken at 1+ minute — it
means it has not been validated, and the code contains a specific,
identified reason duration could matter that the existing control never
exercised.

**Status: Closed Coach beta is ON HOLD** pending this validation — this
supersedes any earlier "GO" conclusion recorded elsewhere pending this
check.

**First validation step**: a single ~1-minute disposable recording
through the normal in-app Record flow. Chosen because it's large enough
to meaningfully exercise the memory-buffering step (tens of MB, not KB
— **SUPERSEDED, see the 2026-08-20 entry above**: this was a pre-test
estimate, not a measurement; N1 actually measured 6,484,951 bytes
(~6.2 MiB) for its ~60-second recording, meaningfully lower than "tens of
MB." Treat the 2026-08-20 entry's measured figure as current; do not read
this "tens of MB" phrase as a live assumption.) while remaining
cheap/fast/disposable. **Result: PASS — see the 2026-08-20 entry above
for full N1 evidence and the current validation-ladder status.**

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
