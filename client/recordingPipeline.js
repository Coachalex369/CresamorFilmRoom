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

function recordingPipelineUploadFilename(recording) {
  const isNativeFile = typeof File !== "undefined" && recording.blob instanceof File;
  if (isNativeFile) return recording.blob.name;

  const extension = (recording.mimeType || "video/webm").includes("mp4") ? "mp4" : "webm";
  return `recording-${recording.createdAt}.${extension}`;
}

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

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      recordingLibrary.updateProgress(recording.recordingId, percent);
    });

    xhr.addEventListener("load", async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const uploaded = JSON.parse(xhr.responseText);

          await recordingLibrary.markSynced(recording.recordingId, {
            serverVideoId: uploaded.id,
            needsConversion: Boolean(uploaded.needs_conversion),
          });

          if (!uploaded.needs_conversion) {
            await recordingLibrary.markProcessed(recording.recordingId);
          }

          resolve(true);
        } catch (error) {
          console.error("Failed to parse upload response:", error);
          await recordingLibrary.markFailed(recording.recordingId, error);
          resolve(false);
        }
      } else if (xhr.status === 401) {
        console.error("Upload failed: session expired");

        if (typeof window.logoutLocalState === "function") {
          window.logoutLocalState();
        }

        await recordingLibrary.markFailed(recording.recordingId, new Error("Session expired"));
        resolve(false);
      } else {
        console.error("Upload failed:", xhr.status, xhr.responseText);
        await recordingLibrary.markFailed(
          recording.recordingId,
          new Error(`Upload failed (${xhr.status})`)
        );
        resolve(false);
      }
    });

    xhr.addEventListener("error", async () => {
      console.error("Upload failed: network error");
      await recordingLibrary.markFailed(recording.recordingId, new Error("Network error"));
      resolve(false);
    });

    xhr.send(formData);
  });
}

async function recordingPipelineProcessNext() {
  if (recordingPipelineBusy) return;

  const pending = await recordingLibrary.getPendingUpload();
  const next = pending[0];
  if (!next) return;

  recordingPipelineBusy = true;
  let succeeded = false;

  try {
    succeeded = await recordingPipelineUpload(next);
  } finally {
    recordingPipelineBusy = false;
  }

  // Only immediately continue draining the queue on success (to pick up
  // the *next* distinct recording, if any). A failure must NOT retry the
  // same recording in a tight loop — recordingLibrary.markFailed() already
  // reverted it to local+queued, so without this guard it would be picked
  // right back up by getPendingUpload() and hammered instantly. Retries
  // only happen via the `online` event and the load-time reconciliation
  // pass, both of which call this function fresh.
  if (succeeded) {
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
