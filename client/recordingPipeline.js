/*
  recordingPipeline.js — the one consumer that moves recordings from the
  Recording Library to the team's cloud copy. Never touches IndexedDB
  directly; only calls recordingLibrary's API and reports results back
  through it. A future consumer (export, editing, an AI-analysis hand-off)
  would be written the same way — as its own small file reacting to
  recordingLibrary — not by extending this one.

  One recording in flight at a time (sideline connections are often
  poor — don't saturate them). Retries are triggered by the browser's
  `online` event, a reconciliation pass on load, AND a periodic timer
  (see RETRY_CHECK_INTERVAL_MS) — added after a real production case
  where a recording failed once (a transient network hiccup, not a true
  offline period) and sat stuck at 'local' forever: browsers are
  conservative about firing 'online'/'offline' events for a connection
  that's merely spotty rather than fully disconnected, so a recording
  that fails without ever triggering a real offline->online transition,
  on a page the user never reloads, had no remaining path back to the
  server. The user experience made this invisible too — local playback
  keeps working fine regardless, so there was no visible sign anything
  was wrong. The periodic check is the safety net for exactly that gap.

  Loaded after recordingLibrary.js, before capture.js.
*/

let recordingPipelineBusy = false;

// Production bug fix: a real mobile upload can stall completely — zero
// bytes moving, no error, no load — and without a bound on that, it never
// resolves at all, permanently blocking recordingPipelineBusy and every
// recording behind it. This is a STALL timeout, not a total-duration
// timeout: the timer resets on every real upload.progress event, so it
// only fires after this many ms with genuinely NO progress, not merely a
// slow-but-moving upload of a large file. Chosen to tolerate normal
// connection setup/slow-start on a poor sideline connection without
// making a user wait too long for a clear "paused, will retry" signal.
const UPLOAD_STALL_TIMEOUT_MS = 30000;

function recordingPipelineUploadFilename(recording) {
  const isNativeFile = typeof File !== "undefined" && recording.blob instanceof File;
  if (isNativeFile) return recording.blob.name;

  const extension = (recording.mimeType || "video/webm").includes("mp4") ? "mp4" : "webm";
  return `recording-${recording.createdAt}.${extension}`;
}

// Resolves with a status string, not a plain boolean — "success",
// "stalled", or "failed" — because recordingPipelineProcessNext() treats
// a stall differently from a generic failure (see the comment there):
// UPLOAD_STALL_TIMEOUT_MS has already elapsed by the time a stall
// resolves, so continuing the queue immediately is safe and is what
// actually gives a second queued recording its turn; a fast/generic
// failure must not be retried instantly.
async function recordingPipelineUpload(recording) {
  debugLog(
    `recordingPipelineUpload() starting: recordingId=${recording.recordingId}`,
    `blobSize=${recording.blob?.size} blobType=${recording.blob?.type || "(none)"}`,
    `filename=${recordingPipelineUploadFilename(recording)}`
  );

  await recordingLibrary.markUploading(recording.recordingId);

  const pointBBuffer = await recording.blob.arrayBuffer();
  const pointBBytes = pointBBuffer.byteLength;
  debugLog(
    "POINT B (post-IndexedDB):",
    `reportedSize=${recording.blob.size}`,
    `actualBytes=${pointBBytes}`,
    `type=${recording.blob.type || "(none)"}`,
    `name=${recording.blob.name || "(none)"}`
  );

  // EXPERIMENT (native-recording 500 investigation): upload a brand-new,
  // JS-memory-backed Blob built from the bytes Point B already read,
  // instead of handing XHR the original recording.blob — a reference into
  // IndexedDB's own Blob backing store, suspected of failing under XHR's
  // STREAMING read even though it survives the one-shot bulk read Point
  // A/B already prove succeeds. Reuses pointBBuffer rather than reading a
  // third time. Does not touch recordingLibrary/IndexedDB storage itself —
  // only what this one upload attempt sends. Controlled experiment, not a
  // committed fix — remove alongside the rest of this investigation's
  // diagnostics once resolved.
  const uploadBlobType = recording.blob.type || recording.mimeType || "video/quicktime";
  const uploadBlob = new Blob([pointBBuffer], { type: uploadBlobType });
  debugLog(
    "EXPERIMENT rebuilt upload Blob:",
    `originalType=${recording.blob.type || "(none)"} originalSize=${recording.blob.size}`,
    `rebuiltType=${uploadBlob.type} rebuiltSize=${uploadBlob.size}`
  );

  return new Promise((resolve) => {
    const formData = new FormData();

    formData.append("video", uploadBlob, recordingPipelineUploadFilename(recording));
    formData.append("title", recording.title);

    if (recording.teamId) {
      formData.append("team_id", recording.teamId);
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/upload-video`);

    // Beta Readiness Sprint 2: an offline-queued recording gets attributed
    // to whoever is logged in when the sync finally succeeds — not
    // necessarily who was logged in when it was recorded. That's the
    // correct consequence of trusting the token as the source of
    // identity, not a bug.
    if (authToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
    }

    // settled guards against the stall timer and a real XHR event (load/
    // error) both trying to resolve/mark this recording — whichever
    // happens first wins, the other is a no-op.
    let settled = false;
    let stallTimer = null;

    function clearStallTimer() {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    }

    function armStallTimer() {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;

        debugLog(`recordingPipelineUpload() stalled (no progress for ${UPLOAD_STALL_TIMEOUT_MS / 1000}s), aborting recordingId=${recording.recordingId}`);
        console.error(
          `Upload stalled (no progress for ${UPLOAD_STALL_TIMEOUT_MS / 1000}s), aborting:`,
          recording.recordingId
        );

        // abort() does not fire 'error' or 'load' per the XHR spec — only
        // 'abort' — so this is the one path that needs to do its own
        // markFailed()/resolve(), not rely on the other listeners below.
        xhr.abort();
        recordingLibrary
          .markFailed(recording.recordingId, new Error("Upload timed out — no progress"))
          .finally(() => resolve("stalled"));
      }, UPLOAD_STALL_TIMEOUT_MS);
    }

    let debugLoggedFirstProgress = false;

    xhr.upload.addEventListener("progress", (event) => {
      if (!debugLoggedFirstProgress) {
        debugLoggedFirstProgress = true;
        debugLog(`recordingPipelineUpload() first progress event: loaded=${event.loaded} total=${event.total}`);
      }

      // Real progress is exactly what distinguishes "stalled" from
      // "slow but genuinely moving" — reset the clock, don't just cancel
      // it, so a large file on a slow-but-working connection is never
      // penalized for taking a while in total.
      armStallTimer();

      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      recordingLibrary.updateProgress(recording.recordingId, percent);
    });

    xhr.addEventListener("load", async () => {
      debugLog(`recordingPipelineUpload() xhr load: status=${xhr.status} body=${(xhr.responseText || "").slice(0, 300)}`);

      if (settled) return;
      settled = true;
      clearStallTimer();

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const uploaded = JSON.parse(xhr.responseText);

          // Production bug fix: this used to mark the recording
          // 'processed' (hiding the local copy) the instant the upload
          // response looked good — trusting that a 201 meant the video
          // was genuinely visible/retrievable. It wasn't always true (a
          // real permissions bug briefly made a video invisible even to
          // its own uploader), and the local recording would vanish with
          // nothing to replace it. Now this only records 'synced' —
          // app.js's loadVideos()/reconcileSyncedRecordings() promotes it
          // to 'processed' (and only then does the local copy stop
          // showing) once the server row is actually confirmed
          // retrievable, not merely accepted.
          await recordingLibrary.markSynced(recording.recordingId, {
            serverVideoId: uploaded.id,
            needsConversion: Boolean(uploaded.needs_conversion),
          });

          resolve("success");
        } catch (error) {
          console.error("Failed to parse upload response:", error);
          await recordingLibrary.markFailed(recording.recordingId, error);
          resolve("failed");
        }
      } else if (xhr.status === 401) {
        console.error("Upload failed: session expired");

        if (typeof window.logoutLocalState === "function") {
          window.logoutLocalState();
        }

        await recordingLibrary.markFailed(recording.recordingId, new Error("401 Session expired"));
        resolve("failed");
      } else {
        console.error("Upload failed:", xhr.status, xhr.responseText);
        await recordingLibrary.markFailed(
          recording.recordingId,
          new Error(`Upload failed (${xhr.status})`)
        );
        resolve("failed");
      }
    });

    xhr.addEventListener("error", async () => {
      debugLog("recordingPipelineUpload() xhr error event (network-level failure, no HTTP status)");

      if (settled) return;
      settled = true;
      clearStallTimer();

      console.error("Upload failed: network error");
      await recordingLibrary.markFailed(recording.recordingId, new Error("Network error"));
      resolve("failed");
    });

    armStallTimer(); // start the clock before send() — covers "never starts at all" too
    debugLog(`recordingPipelineUpload() sending XHR for recordingId=${recording.recordingId}`);
    xhr.send(formData);
  });
}

async function recordingPipelineProcessNext() {
  // Production bug fix: the busy flag used to be set AFTER the first
  // await (getPendingUpload()) — a check-then-set race. Two calls that
  // both land while busy is still false (e.g. a flaky sideline connection
  // firing the `online` event repeatedly while a genuine upload is still
  // in flight) could both pass the guard, both read the same pending[0],
  // and both start uploading the same recording concurrently. Setting the
  // flag synchronously, before any await, closes that window — the guard
  // and the flag-set are now one atomic step.
  if (recordingPipelineBusy) {
    debugLog("recordingPipelineProcessNext() skipped: already busy");
    return;
  }
  recordingPipelineBusy = true;

  let outcome = "no-op";

  try {
    const pending = await recordingLibrary.getPendingUpload();
    const next = pending[0];
    if (!next) {
      debugLog("recordingPipelineProcessNext() found nothing pending");
      return;
    }

    debugLog(`recordingPipelineProcessNext() starting upload for recordingId=${next.recordingId}`);
    outcome = await recordingPipelineUpload(next); // "success" | "stalled" | "failed"
    debugLog(`recordingPipelineProcessNext() outcome=${outcome} for recordingId=${next.recordingId}`);
  } finally {
    recordingPipelineBusy = false;
  }

  // A plain "failed" (bad response, network error) must NOT retry in a
  // tight loop — recordingLibrary.markFailed() already reverted it to
  // local+queued, and retrying instantly would hammer the same broken
  // request. "stalled" is different: UPLOAD_STALL_TIMEOUT_MS has already
  // elapsed by the time this runs, so an immediate continue here is not a
  // tight loop, and it's what actually lets a second queued recording get
  // its turn right away instead of waiting for the next `online` event or
  // page load — combined with getPendingUpload() now deprioritizing
  // already-retried recordings (see recordingLibrary.js), continuing here
  // picks up a different, never-tried recording if one exists rather than
  // re-hammering the one that just stalled.
  if (outcome === "success" || outcome === "stalled") {
    recordingPipelineProcessNext();
  }
}

// recordingId isn't needed by processNext (it just pulls the oldest pending
// recording from the library), but the parameter is kept so call sites read
// as "sync this specific recording" and a future version can prioritize it.
function recordingPipelineEnqueue(recordingId) {
  recordingPipelineProcessNext();
}

async function recordingPipelineReconcile() {
  const all = await recordingLibrary.getAll();
  const stuck = all.filter((record) => record.lifecycle === "uploading");

  await Promise.all(
    stuck.map((record) =>
      recordingLibrary.markFailed(record.recordingId, new Error("Interrupted before finishing"))
    )
  );

  recordingPipelineProcessNext();
}

// No point attempting while logged out — every request would just 401.
// currentUser is app.js's global, already declared by this point in the
// script load order.
function recordingPipelineRetryIfLoggedIn() {
  if (typeof currentUser !== "undefined" && currentUser) {
    recordingPipelineProcessNext();
  }
}

window.addEventListener("online", recordingPipelineRetryIfLoggedIn);

// Mobile production bug fix: the 20s periodic timer below is NOT a
// reliable retry path on a real phone the way it is on a desktop tab.
// iOS Safari (and most mobile browsers) aggressively throttles or fully
// suspends setInterval/setTimeout for a backgrounded tab — and a coach
// recording film is very likely to background the browser within
// seconds of finishing (locking the phone, switching to text a
// teammate, opening another app) since local playback already looks
// completely normal and gives no reason to keep the tab foregrounded.
// A recording whose very first upload attempt hit a bad connection (a
// realistic gym/field sideline condition) could then sit for minutes
// or longer with zero retry attempts actually reaching the network,
// despite the timer "running." visibilitychange/focus/pageshow catch
// the moment the user comes back — pageshow specifically covers the
// iOS bfcache case, where the page is restored from cache on tab
// switch without re-running this file's top-level script at all, so
// nothing else here would fire again on its own to catch up. All three
// route through the same guarded entry point as everywhere else, so a
// tab that regains focus with nothing pending is still a safe no-op.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    recordingPipelineRetryIfLoggedIn();
  }
});
window.addEventListener("focus", recordingPipelineRetryIfLoggedIn);
window.addEventListener("pageshow", recordingPipelineRetryIfLoggedIn);

// Safety-net retry — see file header. Modest interval (matches this
// project's other periodic-refresh conventions, e.g. app.js's video
// poll): a stuck recording waits at most this long for another attempt,
// instead of indefinitely for an 'online' event that may never fire for
// a merely-spotty connection, or a page reload the user has no reason to
// trigger since local playback looks completely normal in the meantime.
// processNext() itself is a no-op (via the busy guard, and getPendingUpload()
// returning empty) whenever there's genuinely nothing to retry, so this
// is safe to leave running continuously — it doesn't hammer anything.
// Still worth keeping alongside the visibility/focus triggers above: a
// tab that stays foregrounded and active (no visibility/focus transition
// at all) still needs its own path to retry a recording that failed
// while the user kept watching.
const RETRY_CHECK_INTERVAL_MS = 20000;
setInterval(recordingPipelineRetryIfLoggedIn, RETRY_CHECK_INTERVAL_MS);

recordingPipelineReconcile();

const recordingPipeline = {
  enqueue: recordingPipelineEnqueue,
};
