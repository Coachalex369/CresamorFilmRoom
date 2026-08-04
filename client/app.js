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

function unavailableReason(video) {
  if (video.__local) return null; // local recordings are always instantly playable via their own blob
  if (video.available === false) return "This video file is no longer available.";
  if (video.needs_conversion) return "This video's format requires conversion and can't be played yet.";
  return null;
}

function resolveVideoSrc(fileUrl) {
  if (fileUrl.startsWith("http") || fileUrl.startsWith("blob:")) return fileUrl;
  return `${API_URL}${fileUrl}`;
}

function selectVideo(video) {
  if (!video) return;

  currentVideoId = video.id;

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
    needs_conversion: false,
    __local: true,
    __recordingId: record.recordingId,
    __lifecycle: record.lifecycle,
    __uploadProgress: record.uploadProgress,
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

  // The local entry drops out of the merged list the instant it's
  // `processed` (see renderVideoList below) — refetch the server list
  // right then so the real row is already there to replace it, instead of
  // a gap where it's briefly in neither list. Not done for `synced`
  // recordings that still need_conversion — those deliberately keep
  // showing their local entry indefinitely, since the local Blob is the
  // only playable copy until real transcoding exists.
  if (lifecycle === "processed" && typeof loadVideos === "function") {
    loadVideos();
  }
});

refreshLocalRecordings();

function renderVideoList() {
  videoList.innerHTML = "";

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

  const mergedVideos = [...localEntries, ...allVideos];

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
      button.textContent = video.available === false
        ? `${video.title} (unavailable)`
        : `${video.title} (conversion needed)`;
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
      } else {
        badge.textContent = "Local";
      }

      button.appendChild(badge);
    }

    button.addEventListener("click", () => {
      selectVideo(video);
    });

    li.appendChild(button);

    if (canDeleteVideoClientSide(video)) {
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
    const videos = await apiFetch("/api/videos");

    if (!Array.isArray(videos) || videos.length === 0) {
      // Foundation Sprint Phase 5: removed a blocking alert() here — it fired
      // for every first-time athlete (only coaches could upload) and froze
      // the tab, including for browser automation. The inline empty-state
      // message below already communicates the same thing without blocking.
      videoList.innerHTML = "<li>No videos found.</li>";
      return;
    }

    allVideos = videos;
    renderVideoList();

    const stillExists = allVideos.find(
      (video) => Number(video.id) === Number(currentVideoId)
    );

    if (stillExists) {
      selectVideo(stillExists);
    } else {
      selectVideo(allVideos[0]);
    }
  } catch (error) {
    console.error("Failed to load videos:", error);
    showMessage("Could not load video.");
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

  setTimeout(() => {
    resizeDrawCanvas();
  }, 50);
}

function logoutLocalState() {
  currentUser = null;
  authToken = null;

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
      selectVideo(data);

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

// Playback-fix pass: a safety net for cases the "available"/"needs_conversion"
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