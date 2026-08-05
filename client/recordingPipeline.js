/*
  recordingPipeline.js — the one consumer that moves recordings from the
  Recording Library to the team's cloud copy. Never touches IndexedDB
  directly; only calls recordingLibrary's API and reports results back
  through it. A future consumer (export, editing, an AI-analysis hand-off)
  would be written the same way — as its own small file reacting to
  recordingLibrary — not by extending this one.

  Deliberately simple v1: one recording in flight at a time (sideline
  connections are often poor — don't saturate them), retries triggered by
  the browser's `online` event and a reconciliation pass on load. No
  timer-based polling loop, no background-sync worker — those are
  documented future work in ARCHITECTURE.md, not built here.

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
  await recordingLibrary.markUploading(recording.recordingId);

  return new Promise((resolve) => {
    const formData = new FormData();

    formData.append("video", recording.blob, recordingPipelineUploadFilename(recording));
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

        console.error(
          `Upload stalled (no progress for ${UPLOAD_STALL_TIMEOUT_MS / 1000}s), aborting:`,
          recording.recordingId
        );

        // abort() does not fire 'error' or 'load' per the XHR spec — only
        // 'abort' — so this is the one path that needs to do its own
        // markFailed()/resolve(), not rely on the other listeners below.
        xhr.abort();
        recordingLibrary
          .markFailed(recording.recordingId, new Error("Upload stalled — no progress, will retry"))
          .finally(() => resolve("stalled"));
      }, UPLOAD_STALL_TIMEOUT_MS);
    }

    xhr.upload.addEventListener("progress", (event) => {
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

        await recordingLibrary.markFailed(recording.recordingId, new Error("Session expired"));
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
      if (settled) return;
      settled = true;
      clearStallTimer();

      console.error("Upload failed: network error");
      await recordingLibrary.markFailed(recording.recordingId, new Error("Network error"));
      resolve("failed");
    });

    armStallTimer(); // start the clock before send() — covers "never starts at all" too
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
  if (recordingPipelineBusy) return;
  recordingPipelineBusy = true;

  let outcome = "no-op";

  try {
    const pending = await recordingLibrary.getPendingUpload();
    const next = pending[0];
    if (!next) return;

    outcome = await recordingPipelineUpload(next); // "success" | "stalled" | "failed"
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

window.addEventListener("online", () => recordingPipelineProcessNext());

recordingPipelineReconcile();

const recordingPipeline = {
  enqueue: recordingPipelineEnqueue,
};
