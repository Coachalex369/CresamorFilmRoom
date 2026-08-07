const API_URL = "https://cresamorfilmroom-3.onrender.com";

// Beta Readiness Sprint 2: every request now carries the bearer token
// automatically — no call site needs to remember to attach it. A 401
// means the token is missing/invalid/expired/for a deleted user; there's
// nothing a retry can fix, so local auth state is cleared and the user is
// sent back to the login screen. window.logoutLocalState (not a captured
// reference) because home.js patches that function — the patched version
// needs to run, not app.js's original.
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Non-JSON response:", text);
      throw new Error("Server returned invalid JSON.");
    }
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window.logoutLocalState === "function") {
      window.logoutLocalState();
      showMessage("Your session expired — please log in again.");
    }

    const error = new Error(data?.error || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return data;
}

const emailInput = document.querySelector("#email-input");
const passwordInput = document.querySelector("#password-input");

const loginCoachBtn = document.querySelector("#login-coach-btn");
const loginAthleteBtn = document.querySelector("#login-athlete-btn");
const logoutBtn = document.querySelector("#logout-btn");

const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");
const currentRoleLabel = document.querySelector("#current-role-label");

const coachOnlyElements = document.querySelectorAll(".coach-only");

const videoSection = document.querySelector("#video-section");
const videoWrapper = document.querySelector("#video-wrapper");
const filmPlayer = document.querySelector("#film-player");
const drawCanvas = document.querySelector("#draw-canvas");
const drawContext = drawCanvas.getContext("2d");

const drawToggleBtn = document.querySelector("#draw-toggle-btn");
const drawFreehandBtn = document.querySelector("#draw-freehand-btn");
const drawLineBtn = document.querySelector("#draw-line-btn");
const drawCircleBtn = document.querySelector("#draw-circle-btn");
const clearDrawingsBtn = document.querySelector("#clear-drawings-btn");

const videoUploadInput = document.querySelector("#video-upload");
const videoList = document.querySelector("#video-list");
const videoStatusMessage = document.querySelector("#video-status-message");
const videoStatusText = document.querySelector("#video-status-text");
const videoEmptyState = document.querySelector("#video-empty-state");

const highlightTitleInput = document.querySelector("#highlight-title-input");
const highlightStartBtn = document.querySelector("#highlight-start-btn");
const highlightEndBtn = document.querySelector("#highlight-end-btn");
const saveHighlightBtn = document.querySelector("#save-highlight-btn");
const highlightsList = document.querySelector("#highlights-list");
const myHighlightsList = document.querySelector("#my-highlights-list");

const playBtn = document.querySelector("#play-btn");
const pauseBtn = document.querySelector("#pause-btn");
const backwardBtn = document.querySelector("#backward-btn");
const forwardBtn = document.querySelector("#forward-btn");
const slowerBtn = document.querySelector("#slower-btn");
const fasterBtn = document.querySelector("#faster-btn");
const resetSpeedBtn = document.querySelector("#reset-speed-btn");
const frameBackBtn = document.querySelector("#frame-back-btn");
const frameForwardBtn = document.querySelector("#frame-forward-btn");
const fullscreenBtn = document.querySelector("#fullscreen-btn");
const speedDisplay = document.querySelector("#speed-display");

let currentUser = null;
let authToken = localStorage.getItem("token") || null;

let clipStartTime = null;
let clipEndTime = null;
let currentVideoId = null;
let allVideos = [];
let myClips = [];

// What selectVideo() last actually wired the player to — storage_key
// (not the signed URL itself, which rotates its query string on every
// fetch even when the underlying object hasn't changed) plus
// processing_status, so a poll can tell "genuinely different object /
// status" apart from "same video, freshly re-signed URL." Compared
// against on every poll tick (see pollVideosQuietly) to catch a video
// whose storage_key changed underneath the current selection — e.g. a
// remux completing — even without the user leaving and returning to the
// tab. Set to null initially; only meaningful once selectVideo() has run.
let lastRenderedVideoSignature = null;

function videoSignature(video) {
  return video ? `${video.id}:${video.storage_key || video.file_url}:${video.processing_status}` : null;
}

/* ---------- DRAWING STATE ---------- */

let drawingEnabled = false;
let drawingMode = "freehand";
let isDrawing = false;
let startPoint = null;
let lastPoint = null;
let savedCanvasImage = null;

function showMessage(message) {
  alert(message);
}

function setCoachVisibility(role) {
  const isCoach = role === "coach";

  coachOnlyElements.forEach((element) => {
    if (isCoach) {
      element.classList.remove("hidden");
    } else {
      element.classList.add("hidden");
    }
  });
}

function updateSpeedDisplay() {
  speedDisplay.textContent = `${filmPlayer.playbackRate}x`;
}

function showVideoStatusMessage(text) {
  if (!videoStatusMessage || !videoStatusText) return;
  videoStatusText.textContent = text;
  videoStatusMessage.classList.remove("hidden");

  // The loading overlay listens for its own loadstart/error events on
  // filmPlayer (home.js's wireVideoLoadingOverlay) and isn't guaranteed to
  // have hidden itself by the time this runs — force it closed so the two
  // semi-transparent overlays don't stack into a muddy double vignette.
  const loadingOverlay = document.querySelector("#video-loading-overlay");
  if (loadingOverlay) loadingOverlay.classList.add("hidden");
}

function hideVideoStatusMessage() {
  if (!videoStatusMessage) return;
  videoStatusMessage.classList.add("hidden");
}

// Play-First Pipeline: status-driven off the server-computed playback_state
// field (uploading / preparing_playback / playable / processing_paused /
// failed) rather than the raw processing_status — video size is never a
// reason shown here that a video can't be watched; "too large" no longer
// exists as a user-facing state anywhere in this app.
function unavailableReason(video) {
  if (video.__local) return null; // local recordings are always instantly playable via their own blob
  if (video.available === false) return "This video file is no longer available.";
  if (video.playback_state === "uploading") return "This video is still uploading.";
  if (video.playback_state === "preparing_playback") return "Preparing this video for playback…";
  if (video.playback_state === "processing_paused") return "This video needs additional processing — check back soon.";
  if (video.playback_state === "failed") return "Processing failed for this video.";
  // Defensive fallback: a real object should always have file_url once
  // playback_state exists (withPlaybackStatus() sets both together). If
  // this is ever hit, something upstream passed an unshaped/raw object
  // straight to selectVideo() (the exact bug uploadVideo() used to have) —
  // treat it as "still preparing," never as silently playable.
  if (!video.file_url) return "Preparing this video for playback…";
  return null;
}

function resolveVideoSrc(fileUrl) {
  // Defensive guard: a malformed/unshaped video object (missing
  // file_url entirely) must never crash here — see uploadVideo()'s fix
  // for the real bug this used to hit unguarded (a raw upload response
  // has file_url: null, and fileUrl.startsWith() on null threw,
  // silently corrupting the player's state instead of showing anything).
  if (!fileUrl) return "";
  if (fileUrl.startsWith("http") || fileUrl.startsWith("blob:")) return fileUrl;
  return `${API_URL}${fileUrl}`;
}

function selectVideo(video) {
  if (!video) return;

  // Any real selection means we're past the pre-selection empty state —
  // hide it regardless of whether this video turns out playable or not
  // (an unavailable video still gets its own status message, not this).
  videoEmptyState.classList.add("hidden");

  currentVideoId = video.id;
  lastRenderedVideoSignature = videoSignature(video);

  const reason = unavailableReason(video);

  if (reason) {
    filmPlayer.removeAttribute("src");
    filmPlayer.load();
    showVideoStatusMessage(reason);
  } else {
    hideVideoStatusMessage();
    filmPlayer.src = resolveVideoSrc(video.file_url);
    filmPlayer.load();
  }

  playBtn.disabled = Boolean(reason);

  resizeDrawCanvas();
  clearDrawings();
  renderVideoList();
  renderCurrentVideoHighlights();
}

function canDeleteVideoClientSide(video) {
  if (!currentUser) return false;
  return (
    currentUser.role === "coach" ||
    Number(currentUser.id) === Number(video.uploaded_by)
  );
}

// Real-Time Sideline Replay: local-only recordings (still local/uploading/
// synced, not yet processed) live in the Recording Library, not the
// videos table — deleting one removes it from IndexedDB and cancels its
// place in the sync queue, there's no server row to call DELETE on yet.
async function deleteLocalRecording(video) {
  const confirmed = confirm(
    `Delete "${video.title}"?\n\nThis will remove the local recording${
      video.__lifecycle === "local" ? " and stop it from syncing" : ""
    }.\nThis action cannot be undone.`
  );

  if (!confirmed) return;

  try {
    await recordingLibrary.remove(video.__recordingId);
    revokeLocalBlobUrl(video.__recordingId);

    if (currentVideoId === video.id) {
      currentVideoId = null;
      filmPlayer.removeAttribute("src");
      filmPlayer.load();
      hideVideoStatusMessage();
      playBtn.disabled = false;

      if (allVideos.length) {
        selectVideo(allVideos[0]);
      } else {
        videoEmptyState.classList.remove("hidden");
        renderCurrentVideoHighlights();
      }
    }
    // renderVideoList() runs automatically via the recordingLibrary
    // subscription (refreshLocalRecordings) — no manual call needed here.
  } catch (error) {
    console.error("Delete local recording failed:", error);
    showMessage("Could not delete local recording.");
  }
}

async function deleteVideo(video) {
  if (video.__local) {
    return deleteLocalRecording(video);
  }

  const confirmed = confirm(
    `Delete "${video.title}"?\n\nThis will permanently remove the video and its associated clips.\nThis action cannot be undone.`
  );

  if (!confirmed) return;

  const deleteBtn = videoList.querySelector(
    `[data-delete-video-id="${video.id}"]`
  );

  if (deleteBtn) {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting...";
  }

  try {
    await apiFetch(`/api/videos/${video.id}`, {
      method: "DELETE",
    });

    allVideos = allVideos.filter((v) => v.id !== video.id);
    myClips = myClips.filter((c) => c.video_id !== video.id);

    if (currentVideoId === video.id) {
      currentVideoId = null;
      filmPlayer.removeAttribute("src");
      filmPlayer.load();
      hideVideoStatusMessage();
      playBtn.disabled = false;

      if (allVideos.length) {
        selectVideo(allVideos[0]);
      } else {
        videoEmptyState.classList.remove("hidden");
        renderVideoList();
        renderCurrentVideoHighlights();
      }
    } else {
      renderVideoList();
    }

    if (typeof window.refreshHomeAfterVideoDelete === "function") {
      window.refreshHomeAfterVideoDelete();
    }
  } catch (error) {
    console.error("Delete video failed:", error);
    showMessage("Could not delete video.");

    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete";
    }
  }
}

// Play-First Pipeline: the safe manual retry — lets a coach re-trigger
// classification for a 'failed' or 'processing_paused' video without
// needing a developer. Re-fetches the video list afterward so the
// badge/status updates immediately.
async function retryVideoConversion(video) {
  const retryBtn = videoList.querySelector(`[data-retry-video-id="${video.id}"]`);

  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.textContent = "Retrying...";
  }

  try {
    await apiFetch(`/api/videos/${video.id}/retry-classification`, {
      method: "POST",
    });

    await loadVideos();
  } catch (error) {
    console.error("Retry classification failed:", error);
    showMessage("Could not retry processing this video.");

    if (retryBtn) {
      retryBtn.disabled = false;
      retryBtn.textContent = "Retry";
    }
  }
}

// Real-Time Sideline Replay: the Film Room list is a projection — the
// Recording Library is authoritative for anything this device recorded
// (shown until it's fully `processed`), the server's `allVideos` is the
// synchronized team view layered on top. See ARCHITECTURE.md.
let localRecordings = [];
const localBlobUrlCache = new Map();

function getLocalBlobUrl(record) {
  if (!localBlobUrlCache.has(record.recordingId)) {
    localBlobUrlCache.set(record.recordingId, URL.createObjectURL(record.blob));
  }
  return localBlobUrlCache.get(record.recordingId);
}

function revokeLocalBlobUrl(recordingId) {
  if (!localBlobUrlCache.has(recordingId)) return;
  URL.revokeObjectURL(localBlobUrlCache.get(recordingId));
  localBlobUrlCache.delete(recordingId);
}

function toLocalVideoLike(record) {
  return {
    id: `local-${record.recordingId}`,
    title: record.title,
    file_url: getLocalBlobUrl(record),
    uploaded_by: record.uploadedBy,
    available: true,
    __local: true,
    __recordingId: record.recordingId,
    __lifecycle: record.lifecycle,
    __uploadProgress: record.uploadProgress,
    __retryCount: record.retryCount || 0,
    __lastError: record.lastError || null,
  };
}

async function refreshLocalRecordings() {
  try {
    localRecordings = await recordingLibrary.getAll();
  } catch (error) {
    console.error("Failed to load local recordings:", error);
    localRecordings = [];
  }

  renderVideoList();
}

recordingLibrary.subscribe(({ lifecycle }) => {
  refreshLocalRecordings();

  // Production bug fix: `processed` (the state that hides the local
  // copy) is now only ever reached via reconcileSyncedRecordings()
  // finding real confirmation in the server list — so the refetch has to
  // trigger on `synced` (the point that needs checking), not `processed`
  // (which is now the checked-and-confirmed outcome, set by loadVideos()
  // itself). See recordingPipeline.js and reconcileSyncedRecordings()
  // above for the full reasoning.
  if (lifecycle === "synced" && typeof loadVideos === "function") {
    loadVideos();
  }
});

refreshLocalRecordings();

// Shared by renderVideoList() (what's shown) and loadVideos()/
// pollVideosQuietly()'s fallback reselection (what's auto-selected on a
// fresh page load or when nothing else applies) — these used to disagree:
// the render path already deduped local-vs-server correctly, but the
// reselection path only ever looked at allVideos (server-only), so a
// fresh page load (currentVideoId reset to null) could auto-select the
// not-yet-playable SERVER row for a recording whose LOCAL blob was still
// the correct, working playback source — exactly the "plays locally,
// breaks after refresh" bug. Both now derive from this one list.
function getMergedVideoList() {
  // Once a recording is `processed`, the server row (in allVideos) is what
  // shows — the library still keeps its own copy underneath regardless,
  // it just doesn't need to render twice.
  // A record with no valid Blob (shouldn't happen — recordingLibrary.create()
  // validates this now — but defends against any pre-existing/corrupted
  // IndexedDB entry) must not crash rendering for every other video. Skip it,
  // don't let Array.map's all-or-nothing failure take down the whole list.
  const localEntries = localRecordings
    .filter((record) => record.lifecycle !== "processed")
    .filter((record) => {
      if (record.blob instanceof Blob) return true;
      console.error("Skipping corrupted local recording (invalid blob):", record.recordingId);
      return false;
    })
    .map(toLocalVideoLike);

  // A recording that's synced to the server but not yet promoted to
  // 'processed' (still preparing playback — see reconcileSyncedRecordings())
  // already has a local card above; showing its server-side row too would
  // duplicate it under the same title while it's mid-classify/remux.
  // Suppressed at render time, not in the reconciliation logic itself,
  // since that function's job is deciding WHEN to promote, not what to
  // render meanwhile.
  const pendingServerIds = new Set(
    localRecordings
      .filter((record) => record.lifecycle !== "processed" && record.serverVideoId)
      .map((record) => Number(record.serverVideoId))
  );
  const serverEntries = allVideos.filter((video) => !pendingServerIds.has(Number(video.id)));

  return [...localEntries, ...serverEntries];
}

function renderVideoList() {
  videoList.innerHTML = "";

  const mergedVideos = getMergedVideoList();

  mergedVideos.forEach((video) => {
    const li = document.createElement("li");
    li.className = "video-item";

    const button = document.createElement("button");

    button.className = "video-item-btn";

    if (video.id === currentVideoId) {
      button.classList.add("active");
    }

    const reason = unavailableReason(video);

    if (reason) {
      button.classList.add("video-unavailable");
      // Short label here (the list is compact); the full sentence from
      // unavailableReason() shows in the bigger status message once this
      // video is actually selected (see selectVideo()).
      const shortLabels = {
        uploading: "uploading",
        preparing_playback: "preparing",
        processing_paused: "processing",
        failed: "failed",
      };
      const shortLabel =
        video.available === false ? "unavailable" : shortLabels[video.playback_state] || "preparing";
      button.textContent = `${video.title} (${shortLabel})`;
    } else {
      button.textContent = video.title;
    }

    if (video.__local) {
      const badge = document.createElement("span");
      badge.className = "video-item-badge";

      if (video.__lifecycle === "uploading") {
        badge.classList.add("badge-syncing");
        badge.textContent = `Syncing ${video.__uploadProgress || 0}%`;
      } else if (video.__lifecycle === "synced") {
        badge.textContent = "Synced";
      } else if (video.__retryCount > 0) {
        // Real production gap this closes: a recording that failed to
        // upload (network hiccup, session expiry, etc.) reverts to this
        // same 'local' lifecycle as a never-yet-attempted recording, so
        // it looked completely indistinguishable from normal — no visible
        // sign anything was wrong, since local playback keeps working
        // fine regardless. The badge now says so, and the title attribute
        // carries the actual error for diagnosis without needing console
        // access. Retries continue automatically (see recordingPipeline.js's
        // periodic check) — this is informational, not an action needed.
        badge.textContent = `Retrying (${video.__retryCount})`;
        if (video.__lastError) badge.title = video.__lastError;
      } else {
        badge.textContent = "Local";
      }

      button.appendChild(badge);
    } else if (video.playback_state && video.playback_state !== "playable") {
      // Play-First Pipeline: same small-badge pattern as local recordings,
      // applied to server-side videos still moving through classification/
      // remux — keyed off playback_state, not the raw processing_status.
      const badge = document.createElement("span");
      badge.className = "video-item-badge";

      const statusLabels = {
        uploading: "Uploading",
        preparing_playback: "Preparing",
        processing_paused: "Processing",
        failed: "Failed",
      };

      if (video.playback_state === "preparing_playback") {
        badge.classList.add("badge-syncing");
      }

      badge.textContent = statusLabels[video.playback_state] || video.playback_state;
      button.appendChild(badge);
    }

    button.addEventListener("click", () => {
      selectVideo(video);
    });

    li.appendChild(button);

    if (canDeleteVideoClientSide(video)) {
      // Play-First Pipeline: lets a coach self-serve a failed or paused
      // video without needing a developer.
      if (video.playback_state === "failed" || video.playback_state === "processing_paused") {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "video-retry-btn";
        retryBtn.textContent = "Retry";
        retryBtn.dataset.retryVideoId = video.id;

        retryBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          retryVideoConversion(video);
        });

        li.appendChild(retryBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "video-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.dataset.deleteVideoId = video.id;

      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteVideo(video);
      });

      li.appendChild(deleteBtn);
    }

    videoList.appendChild(li);
  });
}

function jumpToClip(clip) {
  if (!clip) return;

  if (clip.video_id !== currentVideoId) {
    const matchingVideo = allVideos.find((video) => video.id === clip.video_id);

    if (matchingVideo) {
      selectVideo(matchingVideo);
    }
  }

  filmPlayer.currentTime = Number(clip.start_time) || 0;
  filmPlayer.play().catch(() => {});
}

function renderClipList(targetList, clips, includeVideoTitle = false) {
  targetList.innerHTML = "";

  if (!clips.length) {
    targetList.innerHTML = "<li>No highlights yet.</li>";
    return;
  }

  clips.forEach((clip) => {
    const li = document.createElement("li");
    const button = document.createElement("button");

    button.className = "highlight-item-btn";

    button.innerHTML = `
      <strong>${clip.title}</strong>
      <small>${Number(clip.start_time).toFixed(1)}s - ${Number(
      clip.end_time
    ).toFixed(1)}s${
      includeVideoTitle && clip.video_title ? ` • ${clip.video_title}` : ""
    }</small>
    `;

    button.addEventListener("click", () => {
      jumpToClip(clip);
    });

    li.appendChild(button);
    targetList.appendChild(li);
  });
}

function renderCurrentVideoHighlights() {
  const currentVideoClips = myClips.filter(
    (clip) => Number(clip.video_id) === Number(currentVideoId)
  );

  renderClipList(highlightsList, currentVideoClips, false);
}

async function loadVideos() {
  try {
    // Fresh from IndexedDB, not the module-level snapshot — same
    // reasoning as pollVideosQuietly()/reconcileSyncedRecordings(): this
    // can run concurrently with a recordingLibrary lifecycle event
    // elsewhere, so the cached localRecordings isn't guaranteed current.
    try {
      localRecordings = await recordingLibrary.getAll();
    } catch (error) {
      console.error("Failed to refresh local recordings during loadVideos:", error);
    }

    const videos = await apiFetch("/api/videos");
    allVideos = Array.isArray(videos) ? videos : [];

    // Production bug fix: this used to early-return here on an empty
    // server list, replacing the ENTIRE list with "No videos found" —
    // wiping out any not-yet-synced local recordings too, even though
    // renderVideoList()'s merge would have correctly kept showing them.
    // A local recording must remain visible regardless of what the
    // server currently returns.
    renderVideoList();

    if (!allVideos.length && !localRecordings.length) {
      // Foundation Sprint Phase 5: removed a blocking alert() here — it fired
      // for every first-time athlete (only coaches could upload) and froze
      // the tab, including for browser automation. The inline empty-state
      // message below already communicates the same thing without blocking.
      videoList.innerHTML = "<li>No videos found.</li>";
      videoEmptyState.classList.remove("hidden");
    } else {
      // Real production bug: this used to search allVideos only (server
      // data), never the local-preferring merged list — so on a fresh
      // page load (currentVideoId reset to null by the reload itself),
      // it could auto-select the not-yet-playable SERVER row for a
      // recording whose LOCAL blob was still the correct, working
      // playback source. Symptom: a recording plays fine right after
      // capture, then shows "no longer available" the instant the page
      // is refreshed — the exact bug this fixes.
      const merged = getMergedVideoList();
      const stillExists = merged.find((video) => String(video.id) === String(currentVideoId));

      if (stillExists) {
        selectVideo(stillExists);
      } else if (merged[0]) {
        selectVideo(merged[0]);
      }
    }

    await reconcileSyncedRecordings();
  } catch (error) {
    console.error("Failed to load videos:", error);
    showMessage("Could not load video.");
  }
}

// Production bug fix: a local recording used to get marked 'processed'
// (hiding its local copy) the instant the upload response looked
// successful — trusting a 201 meant it was genuinely visible. That trust
// was misplaced once (a real permissions bug briefly hid a video even
// from its own uploader), and the local recording vanished with nothing
// server-side to replace it. This runs every time the server video list
// is refetched and only promotes a 'synced' recording to 'processed' —
// the point at which its local copy stops rendering — once the matching
// server row is ACTUALLY present AND playable (playback_state ===
// 'playable'). The local Blob is genuinely playable right now and stays
// the authoritative copy until the server copy actually is too, matching
// this project's existing "local Film until real processing completes"
// philosophy.
async function reconcileSyncedRecordings() {
  // Reads IndexedDB fresh rather than trusting the module-level
  // localRecordings snapshot — this runs from loadVideos(), which can be
  // triggered concurrently with refreshLocalRecordings() (both fire from
  // the same subscribe callback), so localRecordings isn't guaranteed to
  // reflect the latest lifecycle change yet by the time this reads it.
  let freshLocal;
  try {
    freshLocal = await recordingLibrary.getAll();
  } catch (error) {
    console.error("Failed to read local recordings for reconciliation:", error);
    return;
  }

  const syncedPending = freshLocal.filter(
    (record) => record.lifecycle === "synced" && record.serverVideoId
  );

  if (!syncedPending.length) return;

  for (const record of syncedPending) {
    const serverVideo = allVideos.find(
      (video) => Number(video.id) === Number(record.serverVideoId)
    );

    if (!serverVideo) continue;
    // The local Blob is genuinely playable right now and stays the
    // authoritative copy until the server copy actually is too — matching
    // this project's "local Film until real processing completes"
    // philosophy. playback_state is the single source of truth for that
    // (record.needsConversion is never populated by the upload response
    // and was always a dead signal here — this used to promote as soon as
    // ANY matching server row existed, even one still classifying/remuxing).
    if (serverVideo.playback_state !== "playable") continue;

    await recordingLibrary.markProcessed(record.recordingId);
  }
}

async function loadMyClips() {
  if (!currentUser) return;

  try {
    const clips = await apiFetch(`/api/users/${currentUser.id}/clips`);

    if (!Array.isArray(clips)) {
      throw new Error("Clips response was not an array");
    }

    myClips = clips;
    renderClipList(myHighlightsList, myClips, true);
    renderCurrentVideoHighlights();
  } catch (error) {
    console.error("Failed to load clips:", error);
    myHighlightsList.innerHTML = "<li>Could not load highlights.</li>";
    highlightsList.innerHTML = "<li>Could not load highlights.</li>";
  }
}

function activateApp(user) {
  currentUser = user;

  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  document.body.classList.add("app-active");

  currentRoleLabel.textContent = user.role || "User";
  logoutBtn.classList.remove("hidden");

  setCoachVisibility(user.role);
  loadVideos();
  loadMyClips();
  refreshVideoPollingState();

  setTimeout(() => {
    resizeDrawCanvas();
  }, 50);
}

function logoutLocalState() {
  currentUser = null;
  authToken = null;
  currentVideoId = null;
  lastRenderedVideoSignature = null;
  stopVideoPolling();

  localStorage.removeItem("token");
  localStorage.removeItem("user");

  loginScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  document.body.classList.remove("app-active");

  currentRoleLabel.textContent = "Not Logged In";
  logoutBtn.classList.add("hidden");

  setCoachVisibility(null);

  emailInput.value = "";
  passwordInput.value = "";
  myHighlightsList.innerHTML = "";
  highlightsList.innerHTML = "";
  videoList.innerHTML = "";

  clipStartTime = null;
  clipEndTime = null;
  currentVideoId = null;
  allVideos = [];
  myClips = [];

  clearDrawings();

  filmPlayer.removeAttribute("src");
  filmPlayer.load();

  if (videoUploadInput) {
    videoUploadInput.value = "";
  }
}

async function loginUser(email, password) {
  const data = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  return data;
}

async function registerUser(email, password, role) {
  const data = await apiFetch("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, role }),
  });

  return data;
}

async function handleAuth(role) {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    showMessage("Please enter both email and password.");
    return;
  }

  try {
    let data;

    try {
      data = await loginUser(email, password);
    } catch (loginError) {
      data = await registerUser(email, password, role);
    }

    authToken = data.token;
    currentUser = data.user;

    localStorage.setItem("token", authToken);
    localStorage.setItem("user", JSON.stringify(currentUser));

    activateApp(currentUser);
  } catch (error) {
    console.error(error);
    showMessage(error.message || "Authentication failed.");
  }
}

function restoreSession() {
  const savedUser = localStorage.getItem("user");

  if (!authToken || !savedUser) {
    logoutBtn.classList.add("hidden");
    return;
  }

  try {
    const parsedUser = JSON.parse(savedUser);
    activateApp(parsedUser);
  } catch (error) {
    console.error("Failed to restore session:", error);
    logoutLocalState();
  }
}

async function saveHighlight() {
  if (!currentUser) {
    showMessage("You must be logged in.");
    return;
  }

  if (!currentVideoId) {
    showMessage("No video is currently loaded.");
    return;
  }

  const title = highlightTitleInput.value.trim();

  if (!title) {
    showMessage("Please enter a highlight title.");
    return;
  }

  if (clipStartTime === null || clipEndTime === null) {
    showMessage("Please set both the start and end of the clip.");
    return;
  }

  if (clipEndTime <= clipStartTime) {
    showMessage("Clip end time must be after start time.");
    return;
  }

  try {
    await apiFetch("/api/clips", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        start_time: clipStartTime,
        end_time: clipEndTime,
        video_id: currentVideoId,
      }),
    });

    highlightTitleInput.value = "";
    clipStartTime = null;
    clipEndTime = null;

    showMessage("Highlight saved.");
    loadMyClips();
  } catch (error) {
    console.error(error);
    showMessage(error.message || "Could not save highlight.");
  }
}

// Sprint 3: converted from fetch to XMLHttpRequest so this manual upload
// path gets the same real progress/percentage/size/ETA feedback as the
// capture.js recording flow — fetch() doesn't expose upload progress events.
function uploadVideo(file) {
  if (!currentUser || currentUser.role !== "coach") {
    showMessage("Only coaches can upload videos.");
    return;
  }

  if (!file) {
    showMessage("Please choose a video file.");
    return;
  }

  const progressSection = document.querySelector("#manual-upload-progress");
  const progressFill = document.querySelector("#manual-upload-progress-fill");
  const progressPercent = document.querySelector("#manual-upload-percent");
  const progressSize = document.querySelector("#manual-upload-size");
  const progressEta = document.querySelector("#manual-upload-eta");

  const formData = new FormData();

  formData.append("video", file);
  formData.append("title", file.name);

  const startedAt = Date.now();

  if (progressSection) {
    progressSection.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressPercent.textContent = "0%";
    progressSize.textContent = "";
    progressEta.textContent = "";
  }

  const xhr = new XMLHttpRequest();

  xhr.open("POST", `${API_URL}/api/upload-video`);

  if (authToken) {
    xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
  }

  xhr.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable || !progressSection) return;

    const percent = Math.round((event.loaded / event.total) * 100);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const rate = elapsedSeconds > 0 ? event.loaded / elapsedSeconds : 0;
    const remainingBytes = event.total - event.loaded;
    const etaSeconds = rate > 0 ? Math.round(remainingBytes / rate) : null;

    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    progressSize.textContent = `${(event.loaded / 1024 / 1024).toFixed(1)}MB of ${(event.total / 1024 / 1024).toFixed(1)}MB`;
    progressEta.textContent =
      etaSeconds && etaSeconds > 0
        ? `Estimated time remaining: ${etaSeconds < 60 ? `${etaSeconds}s` : `${Math.round(etaSeconds / 60)}m`}`
        : "";
  });

  xhr.addEventListener("load", async () => {
    if (progressSection) progressSection.classList.add("hidden");

    if (xhr.status >= 200 && xhr.status < 300) {
      const data = JSON.parse(xhr.responseText);

      showMessage("Video uploaded.");
      await loadVideos();

      // Real production bug: `data` is the raw POST /api/upload-video
      // response (INSERT ... RETURNING *) — it was never run through
      // withPlaybackStatus(), so it has no playback_state/available and
      // file_url is NULL for every storage_key-based upload. Passing it
      // straight to selectVideo() used to crash inside resolveVideoSrc()
      // (fileUrl.startsWith() on null) partway through, after
      // hideVideoStatusMessage() had already cleared whatever loadVideos()
      // had JUST correctly shown — leaving the player in a broken,
      // half-updated state immediately after a successful upload. Look up
      // the freshly-fetched, correctly-shaped version instead —
      // loadVideos() just populated allVideos with it.
      const freshlyUploaded = allVideos.find((video) => Number(video.id) === Number(data.id));
      if (freshlyUploaded) {
        selectVideo(freshlyUploaded);
      }

      if (videoUploadInput) {
        videoUploadInput.value = "";
      }
    } else if (xhr.status === 401) {
      console.error("Upload failed: session expired");

      if (typeof window.logoutLocalState === "function") {
        window.logoutLocalState();
      }

      showMessage("Your session expired — please log in again.");
    } else {
      console.error("Upload failed:", xhr.status, xhr.responseText);
      showMessage("Could not upload video.");
    }
  });

  xhr.addEventListener("error", () => {
    if (progressSection) progressSection.classList.add("hidden");
    console.error("Upload failed: network error");
    showMessage("Could not upload video.");
  });

  xhr.send(formData);
}

/* ---------- DRAWING FUNCTIONS ---------- */

function resizeDrawCanvas() {
  if (!drawCanvas || !videoWrapper) return;

  const rect = videoWrapper.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  if (!rect.width || !rect.height) return;

  const previousImage = document.createElement("canvas");
  previousImage.width = drawCanvas.width;
  previousImage.height = drawCanvas.height;

  const previousContext = previousImage.getContext("2d");
  previousContext.drawImage(drawCanvas, 0, 0);

  drawCanvas.width = Math.round(rect.width * dpr);
  drawCanvas.height = Math.round(rect.height * dpr);

  drawCanvas.style.width = `${rect.width}px`;
  drawCanvas.style.height = `${rect.height}px`;

  drawContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawContext.lineCap = "round";
  drawContext.lineJoin = "round";
  drawContext.strokeStyle = "#2dd4bf";
  drawContext.lineWidth = 4;

  if (previousImage.width && previousImage.height) {
    drawContext.drawImage(previousImage, 0, 0, rect.width, rect.height);
  }
}

function getCanvasPoint(event) {
  const rect = drawCanvas.getBoundingClientRect();

  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function saveCanvasPreview() {
  savedCanvasImage = drawContext.getImageData(
    0,
    0,
    drawCanvas.width,
    drawCanvas.height
  );
}

function restoreCanvasPreview() {
  if (!savedCanvasImage) return;

  drawContext.putImageData(savedCanvasImage, 0, 0);
}

function drawFreehandLine(fromPoint, toPoint) {
  drawContext.beginPath();
  drawContext.moveTo(fromPoint.x, fromPoint.y);
  drawContext.lineTo(toPoint.x, toPoint.y);
  drawContext.stroke();
}

function drawStraightLine(fromPoint, toPoint) {
  restoreCanvasPreview();

  drawContext.beginPath();
  drawContext.moveTo(fromPoint.x, fromPoint.y);
  drawContext.lineTo(toPoint.x, toPoint.y);
  drawContext.stroke();
}

function drawCircle(fromPoint, toPoint) {
  restoreCanvasPreview();

  const radius = Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y);

  drawContext.beginPath();
  drawContext.arc(fromPoint.x, fromPoint.y, radius, 0, Math.PI * 2);
  drawContext.stroke();
}

function setDrawingMode(mode) {
  drawingMode = mode;

  if (drawFreehandBtn) drawFreehandBtn.classList.remove("active");
  if (drawLineBtn) drawLineBtn.classList.remove("active");
  if (drawCircleBtn) drawCircleBtn.classList.remove("active");

  if (mode === "freehand" && drawFreehandBtn) {
    drawFreehandBtn.classList.add("active");
  }

  if (mode === "line" && drawLineBtn) {
    drawLineBtn.classList.add("active");
  }

  if (mode === "circle" && drawCircleBtn) {
    drawCircleBtn.classList.add("active");
  }
}

function setDrawingEnabled(enabled) {
  drawingEnabled = enabled;

  if (drawingEnabled) {
    resizeDrawCanvas();
    filmPlayer.pause();
    drawCanvas.style.pointerEvents = "auto";
    drawCanvas.style.touchAction = "none";
    drawToggleBtn.textContent = "Disable Draw";
    drawToggleBtn.classList.add("active");
    setDrawingMode(drawingMode);
  } else {
    isDrawing = false;
    drawCanvas.style.pointerEvents = "none";
    drawCanvas.style.touchAction = "auto";
    drawToggleBtn.textContent = "Enable Draw";
    drawToggleBtn.classList.remove("active");
  }
}

function clearDrawings() {
  if (!drawCanvas) return;

  drawContext.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  savedCanvasImage = null;
}

function handlePointerDown(event) {
  if (!drawingEnabled) return;

  event.preventDefault();

  resizeDrawCanvas();

  isDrawing = true;
  startPoint = getCanvasPoint(event);
  lastPoint = startPoint;

  drawCanvas.setPointerCapture(event.pointerId);

  if (drawingMode === "line" || drawingMode === "circle") {
    saveCanvasPreview();
  }
}

function handlePointerMove(event) {
  if (!drawingEnabled || !isDrawing) return;

  event.preventDefault();

  const currentPoint = getCanvasPoint(event);

  if (drawingMode === "freehand") {
    drawFreehandLine(lastPoint, currentPoint);
    lastPoint = currentPoint;
  }

  if (drawingMode === "line") {
    drawStraightLine(startPoint, currentPoint);
  }

  if (drawingMode === "circle") {
    drawCircle(startPoint, currentPoint);
  }
}

function handlePointerUp(event) {
  if (!drawingEnabled || !isDrawing) return;

  event.preventDefault();

  isDrawing = false;
  startPoint = null;
  lastPoint = null;
  savedCanvasImage = null;

  try {
    drawCanvas.releasePointerCapture(event.pointerId);
  } catch (error) {}
}

/* ---------- AUTH BUTTONS ---------- */

loginCoachBtn.addEventListener("click", () => {
  handleAuth("coach");
});

loginAthleteBtn.addEventListener("click", () => {
  handleAuth("athlete");
});

logoutBtn.addEventListener("click", () => {
  logoutLocalState();
});

/* ---------- HIGHLIGHT BUTTONS ---------- */

highlightStartBtn.addEventListener("click", () => {
  clipStartTime = filmPlayer.currentTime;
  showMessage(`Clip start set at ${clipStartTime.toFixed(1)}s`);
});

highlightEndBtn.addEventListener("click", () => {
  clipEndTime = filmPlayer.currentTime;
  showMessage(`Clip end set at ${clipEndTime.toFixed(1)}s`);
});

saveHighlightBtn.addEventListener("click", () => {
  saveHighlight();
});

/* ---------- PLAYBACK BUTTONS ---------- */

playBtn.addEventListener("click", async () => {
  const currentVideo = allVideos.find((v) => v.id === currentVideoId);
  const reason = currentVideo ? unavailableReason(currentVideo) : null;

  if (reason) {
    showMessage(reason);
    return;
  }

  try {
    await filmPlayer.play();
  } catch (error) {
    console.error("Play failed:", error);
    showMessage("Could not play video.");
  }
});

// Playback-fix pass: a safety net for cases the "available"/"playback_state"
// flags from GET /api/videos don't catch (e.g. a file removed between the
// list load and actual playback). Without this the player just logs
// NotSupportedError silently on every failed play() attempt.
filmPlayer.addEventListener("error", () => {
  if (!filmPlayer.getAttribute("src")) return;
  showVideoStatusMessage("This video file is no longer available.");
  playBtn.disabled = true;
});

pauseBtn.addEventListener("click", () => {
  filmPlayer.pause();
});

backwardBtn.addEventListener("click", () => {
  filmPlayer.currentTime = Math.max(0, filmPlayer.currentTime - 5);
});

forwardBtn.addEventListener("click", () => {
  const nextTime = filmPlayer.currentTime + 5;

  filmPlayer.currentTime = filmPlayer.duration
    ? Math.min(filmPlayer.duration, nextTime)
    : nextTime;
});

slowerBtn.addEventListener("click", () => {
  filmPlayer.playbackRate = Math.max(0.25, filmPlayer.playbackRate - 0.25);
  updateSpeedDisplay();
});

fasterBtn.addEventListener("click", () => {
  filmPlayer.playbackRate = Math.min(3, filmPlayer.playbackRate + 0.25);
  updateSpeedDisplay();
});

resetSpeedBtn.addEventListener("click", () => {
  filmPlayer.playbackRate = 1;
  updateSpeedDisplay();
});

frameBackBtn.addEventListener("click", () => {
  filmPlayer.pause();
  filmPlayer.currentTime = Math.max(0, filmPlayer.currentTime - 1 / 30);
});

frameForwardBtn.addEventListener("click", () => {
  filmPlayer.pause();

  const nextTime = filmPlayer.currentTime + 1 / 30;

  filmPlayer.currentTime = filmPlayer.duration
    ? Math.min(filmPlayer.duration, nextTime)
    : nextTime;
});

fullscreenBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) {
      if (videoSection.requestFullscreen) {
        await videoSection.requestFullscreen();
      }
    } else {
      await document.exitFullscreen();
    }

    setTimeout(() => {
      resizeDrawCanvas();
    }, 100);
  } catch (error) {
    console.error("Fullscreen failed:", error);
  }
});

/* ---------- DRAWING BUTTONS ---------- */

if (drawToggleBtn) {
  drawToggleBtn.addEventListener("click", () => {
    setDrawingEnabled(!drawingEnabled);
  });
}

if (drawFreehandBtn) {
  drawFreehandBtn.addEventListener("click", () => {
    setDrawingMode("freehand");
  });
}

if (drawLineBtn) {
  drawLineBtn.addEventListener("click", () => {
    setDrawingMode("line");
  });
}

if (drawCircleBtn) {
  drawCircleBtn.addEventListener("click", () => {
    setDrawingMode("circle");
  });
}

if (clearDrawingsBtn) {
  clearDrawingsBtn.addEventListener("click", () => {
    clearDrawings();
  });
}

if (drawCanvas) {
  drawCanvas.addEventListener("pointerdown", handlePointerDown);
  drawCanvas.addEventListener("pointermove", handlePointerMove);
  drawCanvas.addEventListener("pointerup", handlePointerUp);
  drawCanvas.addEventListener("pointercancel", handlePointerUp);
}

/* ---------- UPLOAD ---------- */

if (videoUploadInput) {
  videoUploadInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    uploadVideo(file);
  });
}

/* ---------- TAB NAVIGATION ---------- */

const tabButtons = document.querySelectorAll(".tab-btn");
const appScreens = document.querySelectorAll(".app-screen");

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const screenId = button.dataset.screen;

    tabButtons.forEach((btn) => {
      btn.classList.remove("active");
    });

    appScreens.forEach((screen) => {
      screen.classList.remove("active");
    });

    button.classList.add("active");

    const selectedScreen = document.getElementById(screenId);

    if (selectedScreen) {
      selectedScreen.classList.add("active");
    }

    setTimeout(() => {
      resizeDrawCanvas();
    }, 50);
  });
});

/* ---------- FILM ROOM POLLING ---------- */

// Cross-device visibility fix: without this, a laptop tab already open
// before a phone recording syncs (or before a video's classify/remux
// finishes) never learns about it — the list and player just sit on
// stale data until the user manually reloads. That staleness is also
// what makes a video LOOK broken: an already-fetched signed URL can end
// up pointing at the pre-remux original object, whose container the
// browser can't decode, surfacing as the same generic "no longer
// available" message a truly missing file would show. Mirrors
// messages.js's established polling pattern (same gating: screen active +
// tab visible + logged in) rather than inventing a new one.
const VIDEO_POLL_INTERVAL_MS = 8000;
let filmScreenActive = false;
let videoPollTimer = null;
let videoPollBusy = false;

// forceRefreshCurrent: true only for the tab-entry poll (tab click,
// visibility-to-visible, window focus) — never for the routine interval
// tick. Fixes a real staleness bug: a video that was ALREADY playable
// (playBtn not disabled) never got its signed URL refreshed on later
// polls, since the old logic only re-wired the player for a video that
// was previously BLOCKED. A signed URL is only valid ~20 minutes — if the
// user leaves Film for longer than that (entirely plausible while
// testing Messages/Teams/Profile) and returns, whatever was cached in
// filmPlayer.src is stale. On the routine tick this stays conservative
// (only refresh if it wasn't already playable) so an actively-playing
// video is never interrupted; on tab-entry there's nothing to interrupt
// (the screen was just hidden/inactive), so it's always safe to re-wire.
async function pollVideosQuietly({ forceRefreshCurrent = false } = {}) {
  if (videoPollBusy || !currentUser) return;
  videoPollBusy = true;

  try {
    // Re-read from IndexedDB fresh rather than trusting the module-level
    // localRecordings snapshot — same reasoning as reconcileSyncedRecordings()
    // below (which already does this): this poll can run concurrently with
    // a recordingLibrary lifecycle event elsewhere, so the cached snapshot
    // isn't guaranteed current. renderVideoList()'s dedup logic depends on
    // this being accurate, or a just-synced local recording can render
    // against a stale lifecycle and point at the wrong playback source.
    try {
      localRecordings = await recordingLibrary.getAll();
    } catch (error) {
      console.error("Failed to refresh local recordings during video poll:", error);
    }

    const videos = await apiFetch("/api/videos");
    allVideos = Array.isArray(videos) ? videos : [];
    // List/badge markup only — renderVideoList() never touches filmPlayer,
    // so this is always safe even while a video is actively playing.
    renderVideoList();

    const current = allVideos.find((video) => Number(video.id) === Number(currentVideoId));
    // Never touches a video that's genuinely mid-playback, full stop —
    // whether this is the tab-entry poll or a routine tick.
    const notActivelyPlaying = filmPlayer.paused || filmPlayer.ended;
    // Catches a video whose storage_key/processing_status genuinely
    // changed underneath the current selection (e.g. a remux completing)
    // even on a routine tick, not just tab-entry — signature comparison
    // (not the signed URL itself, which rotates its query string on every
    // fetch regardless) is what makes this safe to check unconditionally
    // without spuriously reloading an unchanged video.
    const signatureChanged =
      current && lastRenderedVideoSignature !== null && videoSignature(current) !== lastRenderedVideoSignature;

    if (current && notActivelyPlaying && (forceRefreshCurrent || playBtn.disabled || signatureChanged)) {
      selectVideo(current);
    } else if (!currentVideoId) {
      // Same local-preferring fallback as loadVideos() — see
      // getMergedVideoList()'s comment for why this can't just use
      // allVideos[0].
      const merged = getMergedVideoList();
      if (merged[0]) selectVideo(merged[0]);
    }

    await reconcileSyncedRecordings();
  } catch (error) {
    if (error?.status === 401) {
      stopVideoPolling();
      return;
    }
    console.error("Video poll failed:", error);
  } finally {
    videoPollBusy = false;
  }
}

function startVideoPolling() {
  if (!videoPollTimer) {
    videoPollTimer = setInterval(() => pollVideosQuietly(), VIDEO_POLL_INTERVAL_MS);
  }
}

function stopVideoPolling() {
  if (videoPollTimer) {
    clearInterval(videoPollTimer);
    videoPollTimer = null;
  }
}

// Polling only actually runs when the Film screen is the selected tab AND
// the tab/window is visible AND someone's logged in — any other
// combination stops the timer. Called from the tab-click listener,
// visibilitychange, window focus, and login/logout.
function refreshVideoPollingState({ immediate = false } = {}) {
  const shouldPoll = filmScreenActive && document.visibilityState === "visible" && Boolean(currentUser);

  if (shouldPoll) {
    startVideoPolling();
    if (immediate) pollVideosQuietly({ forceRefreshCurrent: true });
  } else {
    stopVideoPolling();
  }
}

// Independent listener on the same tab buttons the tab-navigation section
// below already wires — doesn't touch that click handler, just observes
// the same clicks (multiple listeners on one element is fine, same
// precedent as messages.js).
document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => {
    filmScreenActive = button.dataset.screen === "film-screen";
    refreshVideoPollingState({ immediate: true });
  });
});

document.addEventListener("visibilitychange", () => {
  refreshVideoPollingState({ immediate: document.visibilityState === "visible" });
});

window.addEventListener("focus", () => {
  refreshVideoPollingState({ immediate: true });
});

/* ---------- RESIZE SAFETY ---------- */

window.addEventListener("resize", () => {
  resizeDrawCanvas();
});

document.addEventListener("fullscreenchange", () => {
  setTimeout(() => {
    resizeDrawCanvas();
  }, 100);
});

/* ---------- STARTUP ---------- */

updateSpeedDisplay();
restoreSession();
resizeDrawCanvas();
setDrawingMode("freehand");