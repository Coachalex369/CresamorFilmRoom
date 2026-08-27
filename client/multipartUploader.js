/*
  multipartUploader.js — the browser-side engine for resumable, direct-to-
  R2 multipart video uploads. Talks to server/routes/videoUploads.js.
  Consumes uploadSessions.js for durable resume bookkeeping; never touches
  IndexedDB directly itself.

  Flow for one file:
    1. Look for a resumable local session (same-file-reselection check via
       uploadSessions.findResumable — a fingerprint match, not a name
       match). If found, ask the server what has ACTUALLY landed (GET
       /api/video-uploads/:sessionId — R2's own ListParts, not a trust of
       the local cache) and reconcile before doing anything else.
    2. Otherwise POST /initiate to start a fresh session.
    3. Upload every still-missing part: file.slice() the exact byte range,
       mint a FRESH presigned PUT URL right before each individual attempt
       (never reused across a retry — see r2Storage.js's presignUploadPart
       comment on why), bounded concurrency, per-part retry with backoff.
       Every part success is recorded to uploadSessions immediately, so a
       page reload/app restart mid-upload loses nothing already landed.
    4. POST /complete with every part's {partNumber, etag}. If the server
       reports specific parts as missing/invalid (409), re-upload exactly
       those and retry completion — same protocol server/scripts/
       testMultipartUploads.js already exercises and passes.

  Deliberately does NOT decide on its own when to run — see
  RESUMABLE_UPLOADS_ENABLED below. This file only builds the capability;
  the opt-in gate lives here, and the one call site (app.js's uploadVideo())
  checks shouldUseResumableUpload() before ever invoking it.

  Loaded after app.js (needs API_URL/authToken/window.logoutLocalState) and
  uploadSessions.js, before capture.js.
*/

// Phase B checkpoint: built and syntax/logic-reviewed, not yet turned on
// for real users. Flip this to true (and lower the threshold below) only
// to run the one deliberate small-file browser test the current plan
// calls for — then set it back to false before anything is committed
// further. While false, shouldUseResumableUpload() always returns false
// and uploadVideo() in app.js behaves exactly as it did before this file
// existed — this is the "opt-in/disabled threshold" the plan asked for.
const RESUMABLE_UPLOADS_ENABLED = false;

// Only relevant once the flag above is true. Deliberately well above a
// small test file and well below Track 1's reproduced failure sizes
// (~508MiB/~658MiB) — real threshold-tuning is future work, explicitly out
// of scope for this checkpoint.
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 200 * 1024 * 1024;

function shouldUseResumableUpload(fileSize) {
  return RESUMABLE_UPLOADS_ENABLED && fileSize >= RESUMABLE_UPLOAD_THRESHOLD_BYTES;
}

const MAX_CONCURRENT_PARTS = 3;
const MAX_PART_ATTEMPTS = 5;
const PART_RETRY_BASE_DELAY_MS = 1000;
const PART_RETRY_MAX_DELAY_MS = 30000;
const MAX_COMPLETE_RETRY_ROUNDS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function partRetryDelayMs(attempt) {
  const capped = Math.min(PART_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), PART_RETRY_MAX_DELAY_MS);
  return capped + Math.random() * 500; // jitter, avoids every retrying part waking up in lockstep
}

// A small, purpose-built request helper rather than reusing app.js's
// apiFetch(): a 409 from /complete carries a real body (missingParts) that
// completeWithMissingPartRetry() needs to act on, and apiFetch()'s shared
// error contract (one Error, `.status` only) intentionally discards the
// response body for every one of its many other call sites — widening
// that shape for everyone else isn't justified by this one need. Mirrors
// apiFetch's auth-header/401 handling so behavior stays consistent.
async function videoUploadsApi(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (typeof authToken !== "undefined" && authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window.logoutLocalState === "function") {
      window.logoutLocalState();
    }

    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// Direct PUT to R2's presigned URL — a different origin than our own API,
// so this deliberately does NOT go through videoUploadsApi()/apiFetch()
// (which would attach our own Authorization bearer token to a request R2
// was never meant to see). XHR, not fetch(), so real upload-progress
// events are available for this part — same reason app.js's uploadVideo()
// and recordingPipeline.js's upload both use XHR instead of fetch().
function xhrPutPart(url, chunk, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) {
          reject(new Error("R2 did not return an ETag for this part — check R2 CORS ExposeHeaders"));
          return;
        }
        onProgress(chunk.size);
        resolve(etag);
      } else {
        const error = new Error(`Part upload failed with status ${xhr.status}`);
        error.status = xhr.status;
        reject(error);
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error during part upload")));
    xhr.addEventListener("abort", () => reject(new Error("Part upload aborted")));

    xhr.send(chunk);
  });
}

function isRetryableStatus(status) {
  return status === undefined || status >= 500 || status === 429;
}

// Presigns fresh immediately before every single attempt (including
// retries) — never batch-minted, never reused. A 4xx from either the
// presign call or the PUT itself (session aborted/swept, wrong region,
// etc.) means retrying the identical request would just fail again, so
// only network-level errors and 5xx/429 are retried.
async function uploadPartWithRetry(uploadId, partNumber, chunk, onProgress) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
    try {
      const { url } = await videoUploadsApi(`/api/video-uploads/${uploadId}/parts/${partNumber}/presign`, {
        method: "POST",
      });
      return await xhrPutPart(url, chunk, onProgress);
    } catch (error) {
      lastError = error;
      onProgress(0); // reset this part's in-flight progress before the next attempt

      const retryable = isRetryableStatus(error.status) && attempt < MAX_PART_ATTEMPTS;
      console.error(
        `multipartUploader: part ${partNumber} attempt ${attempt}/${MAX_PART_ATTEMPTS} failed` +
          ` (${retryable ? "will retry" : "not retryable"}):`,
        error.message
      );

      if (!retryable) throw error;
      await sleep(partRetryDelayMs(attempt));
    }
  }

  throw lastError;
}

// Runs `worker` over every item with at most `concurrency` in flight.
// Deliberately never throws mid-flight on an individual item's failure —
// every item is attempted exactly once and every other in-flight worker is
// left to finish naturally, so a single permanently-failed part can never
// silently strand parts that DID succeed (each success is already recorded
// to uploadSessions the moment it happens, regardless of what the pool's
// overall outcome ends up being). Failures are collected and returned for
// the caller to decide what to do with.
async function runPool(items, concurrency, worker) {
  let index = 0;
  const failures = [];

  async function runOne() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= items.length) return;

      try {
        await worker(items[i], i);
      } catch (error) {
        failures.push({ item: items[i], error });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, runOne));
  return failures;
}

// Tracks byte-level progress across every part (completed, in-flight, and
// not-yet-started) so the UI gets one smooth 0-100% figure and an ETA, the
// same quality bar as app.js's uploadVideo()/recordingPipeline.js's XHR
// progress — not a chunky "N of M parts" indicator.
function createProgressTracker(totalBytes, onProgress) {
  const partLoaded = new Map();
  const startedAt = Date.now();

  function emit() {
    let loaded = 0;
    for (const value of partLoaded.values()) loaded += value;

    const percent = totalBytes > 0 ? Math.round((loaded / totalBytes) * 100) : 0;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const rate = elapsedSeconds > 0 ? loaded / elapsedSeconds : 0;
    const remaining = totalBytes - loaded;
    const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;

    if (typeof onProgress === "function") {
      onProgress({ percent, loadedBytes: loaded, totalBytes, etaSeconds });
    }
  }

  return {
    setPartLoaded(partNumber, loaded) {
      partLoaded.set(partNumber, loaded);
      emit();
    },
    markPartDone(partNumber, size) {
      partLoaded.set(partNumber, size);
      emit();
    },
  };
}

function partByteSize(partNumber, partSize, partCount, fileSize) {
  if (partNumber < partCount) return partSize;
  return fileSize - partSize * (partCount - 1);
}

// Circuit breaker: once ANY part exhausts every retry attempt, stop
// launching new part uploads rather than burning the same full retry
// budget on every other still-queued part too (a realistic total-outage
// case — auth expired, network down, R2 incident — would otherwise take
// as long as MAX_PART_ATTEMPTS x every remaining part before finally
// giving up). Parts already in flight when the breaker trips are left to
// finish naturally; whatever they land is still durably recorded via
// uploadSessions, so a later resume only has to redo what's genuinely
// still missing.
async function uploadMissingParts({ uploadId, file, partSize, partCount, fileSize, missingPartNumbers, partsByNumber, tracker }) {
  if (!missingPartNumbers.length) return;

  const circuit = { tripped: false, error: null };

  const failures = await runPool(missingPartNumbers, MAX_CONCURRENT_PARTS, async (partNumber) => {
    if (circuit.tripped) throw new Error("Upload stopped after another part exhausted all retries");

    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const chunk = file.slice(start, end);

    try {
      const etag = await uploadPartWithRetry(uploadId, partNumber, chunk, (loaded) =>
        tracker.setPartLoaded(partNumber, loaded)
      );
      partsByNumber.set(partNumber, etag);
      tracker.markPartDone(partNumber, partByteSize(partNumber, partSize, partCount, fileSize));
      await uploadSessions.recordPart(uploadId, partNumber, etag);
    } catch (error) {
      circuit.tripped = true;
      circuit.error = error;
      throw error;
    }
  });

  if (failures.length) {
    throw circuit.error || failures[0].error;
  }
}

async function completeUploadSession(uploadId, parts) {
  return videoUploadsApi(`/api/video-uploads/${uploadId}/complete`, { method: "POST", body: { parts } });
}

// A 409 here is the server's ONE recoverable case: specific parts it could
// not verify against R2 (see videoUploads.js's /complete handler). Anything
// else — a different status, or a 409 with no missingParts array —
// surfaces as-is; there's nothing this loop can safely do about it.
async function completeWithMissingPartRetry(uploadId, initialParts, { file, partSize, partCount, fileSize, partsByNumber, tracker }) {
  let parts = initialParts;

  for (let round = 1; round <= MAX_COMPLETE_RETRY_ROUNDS; round += 1) {
    try {
      return await completeUploadSession(uploadId, parts);
    } catch (error) {
      if (error.status !== 409 || !Array.isArray(error.data?.missingParts)) throw error;

      if (round === MAX_COMPLETE_RETRY_ROUNDS) {
        throw new Error(
          `complete() still reports missing parts after ${MAX_COMPLETE_RETRY_ROUNDS} retry rounds: ${error.data.missingParts.join(", ")}`
        );
      }

      console.error(
        `multipartUploader: complete() reported missing parts, re-uploading and retrying (round ${round}):`,
        error.data.missingParts
      );

      const failures = await runPool(error.data.missingParts, MAX_CONCURRENT_PARTS, async (partNumber) => {
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, file.size);
        const chunk = file.slice(start, end);

        const etag = await uploadPartWithRetry(uploadId, partNumber, chunk, (loaded) =>
          tracker.setPartLoaded(partNumber, loaded)
        );
        partsByNumber.set(partNumber, etag);
        tracker.markPartDone(partNumber, partByteSize(partNumber, partSize, partCount, fileSize));
        await uploadSessions.recordPart(uploadId, partNumber, etag);
      });

      if (failures.length) throw failures[0].error;

      parts = Array.from(partsByNumber.entries())
        .map(([partNumber, etag]) => ({ partNumber, etag }))
        .sort((a, b) => a.partNumber - b.partNumber);
    }
  }
}

// file: a real File (from an <input type=file>) — needs .name/.lastModified
// for the fingerprint, a plain Blob won't do (matches uploadSessions.js's
// fingerprintOf()).
async function multipartUploaderUpload(file, { title, teamId, onProgress, onStatus } = {}) {
  if (!(file instanceof File)) {
    throw new Error("multipartUploader.upload() requires a real File (needs name/lastModified for resume).");
  }

  const notify = (status) => {
    if (typeof onStatus === "function") onStatus(status);
  };

  let session = await uploadSessions.findResumable(file);

  if (session) {
    notify("resuming");

    // Server is the authority on what has actually landed — never trust
    // the local completedParts cache alone (see uploadSessions.js header).
    const remote = await videoUploadsApi(`/api/video-uploads/${session.uploadId}`);

    if (remote.status === "completed") {
      await uploadSessions.setStatus(session.uploadId, "completed", { videoId: remote.videoId });
      notify("already-completed");
      return videoUploadsApi(`/api/videos/${remote.videoId}`);
    }

    if (remote.status === "aborted") {
      // Stale local session pointing at one the server (or the inactivity
      // sweep) has already given up on — can't resume this, so fall
      // through and start a fresh session for the same file below.
      await uploadSessions.remove(session.uploadId);
      session = null;
    } else {
      await uploadSessions.reconcile(session.uploadId, remote.completedParts);
      session = await uploadSessions.get(session.uploadId);
    }
  }

  if (!session) {
    notify("initiating");

    const initiated = await videoUploadsApi("/api/video-uploads/initiate", {
      method: "POST",
      body: {
        title,
        team_id: teamId,
        file_name: file.name,
        file_size: file.size,
        content_type: file.type,
        last_modified: file.lastModified,
      },
    });

    session = await uploadSessions.create({
      uploadId: initiated.uploadId,
      storageKey: initiated.storageKey,
      teamId,
      title,
      file,
      partSize: initiated.partSize,
      partCount: initiated.partCount,
    });
  }

  const { uploadId, partSize, partCount, fileSize } = session;

  const partsByNumber = new Map(session.completedParts.map((p) => [p.partNumber, p.etag]));
  const tracker = createProgressTracker(fileSize, onProgress);

  const missingPartNumbers = [];
  for (let n = 1; n <= partCount; n += 1) {
    if (partsByNumber.has(n)) {
      tracker.markPartDone(n, partByteSize(n, partSize, partCount, fileSize));
    } else {
      missingPartNumbers.push(n);
    }
  }

  notify(missingPartNumbers.length < partCount ? "resuming-upload" : "uploading");

  await uploadMissingParts({ uploadId, file, partSize, partCount, fileSize, missingPartNumbers, partsByNumber, tracker });

  const sortedParts = Array.from(partsByNumber.entries())
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);

  notify("completing");
  const video = await completeWithMissingPartRetry(uploadId, sortedParts, { file, partSize, partCount, fileSize, partsByNumber, tracker });

  await uploadSessions.setStatus(uploadId, "completed", { videoId: video.id });
  notify("completed");
  return video;
}

async function multipartUploaderAbort(uploadId) {
  await videoUploadsApi(`/api/video-uploads/${uploadId}/abort`, { method: "POST" });
  await uploadSessions.setStatus(uploadId, "aborted");
}

const multipartUploader = {
  upload: multipartUploaderUpload,
  abort: multipartUploaderAbort,
  shouldUseResumableUpload,
};
