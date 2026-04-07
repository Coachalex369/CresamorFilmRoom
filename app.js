const video = document.querySelector("#film-player");
const videoWrapper = document.querySelector("#video-wrapper");

const playBtn = document.querySelector("#play-btn");
const pauseBtn = document.querySelector("#pause-btn");
const backwardBtn = document.querySelector("#backward-btn");
const forwardBtn = document.querySelector("#forward-btn");

const slowerBtn = document.querySelector("#slower-btn");
const fasterBtn = document.querySelector("#faster-btn");
const resetSpeedBtn = document.querySelector("#reset-speed-btn");
const frameBackBtn = document.querySelector("#frame-back-btn");
const frameForwardBtn = document.querySelector("#frame-forward-btn");
const speedDisplay = document.querySelector("#speed-display");
const fullscreenBtn = document.querySelector("#fullscreen-btn");

const noteInput = document.querySelector("#note-input");
const saveNoteBtn = document.querySelector("#save-note-btn");
const notesList = document.querySelector("#notes-list");

const highlightTitleInput = document.querySelector("#highlight-title-input");
const highlightStartBtn = document.querySelector("#highlight-start-btn");
const highlightEndBtn = document.querySelector("#highlight-end-btn");
const saveHighlightBtn = document.querySelector("#save-highlight-btn");
const highlightList = document.querySelector("#highlight-list");

const highlightStar = document.querySelector("#highlight-star");
const timelineBar = document.querySelector("#timeline-bar");
const timelineProgress = document.querySelector("#timeline-progress");
const timelineHighlight = document.querySelector("#timeline-highlight");
const timelineSavedHighlights = document.querySelector("#timeline-saved-highlights");

const videoUpload = document.querySelector("#video-upload");
const videoFileName = document.querySelector("#video-file-name");

// Fullscreen overlay controls
const fullscreenOverlay = document.querySelector("#fullscreen-overlay");

const fsPlayBtn = document.querySelector("#fs-play-btn");
const fsPauseBtn = document.querySelector("#fs-pause-btn");
const fsBackwardBtn = document.querySelector("#fs-backward-btn");
const fsForwardBtn = document.querySelector("#fs-forward-btn");
const fsSlowerBtn = document.querySelector("#fs-slower-btn");
const fsFasterBtn = document.querySelector("#fs-faster-btn");
const fsFrameBackBtn = document.querySelector("#fs-frame-back-btn");
const fsFrameForwardBtn = document.querySelector("#fs-frame-forward-btn");
const fsFullscreenBtn = document.querySelector("#fs-fullscreen-btn");

const fsHighlightStartBtn = document.querySelector("#fs-highlight-start-btn");
const fsHighlightEndBtn = document.querySelector("#fs-highlight-end-btn");
const fsSaveHighlightBtn = document.querySelector("#fs-save-highlight-btn");

const HIGHLIGHTS_STORAGE_KEY = "cresamor-film-room-highlights-v2";

// Fake local user for now
const currentUser = {
  id: "local-user-1",
  email: "coachdemo@cresamor.local",
  displayName: "Coach Demo",
  role: "coach",
};

const notes = [];
let allHighlights = [];

let currentVideo = {
  id: "sample-video",
  sourceType: "sample",
  sourceKey: "sample-video",
  title: "Sample Film",
  uploadedBy: currentUser.id,
  createdAt: new Date().toISOString(),
  status: "active",
  visibility: "private",
  moderationFlags: [],
};

let highlightStart = null;
let highlightEnd = null;
let overlayTimeout = null;

const FRAME_STEP = 1 / 30;

// Temporary sample video
video.src = "https://www.w3schools.com/html/mov_bbb.mp4";

if (videoFileName) {
  videoFileName.textContent = "Sample film loaded";
}

// ---------- HELPERS ----------
function createVideoIdFromFile(file) {
  return `${file.name}-${file.size}`;
}

function loadHighlightsFromStorage() {
  const saved = localStorage.getItem(HIGHLIGHTS_STORAGE_KEY);

  if (!saved) {
    allHighlights = [];
    return;
  }

  try {
    const parsed = JSON.parse(saved);
    allHighlights = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not parse saved highlights:", error);
    allHighlights = [];
  }
}

function saveHighlightsToStorage() {
  localStorage.setItem(HIGHLIGHTS_STORAGE_KEY, JSON.stringify(allHighlights));
}

function getCurrentVideoHighlights() {
  return allHighlights.filter(
    (highlight) => highlight.videoId === currentVideo.id
  );
}

function resetInProgressHighlight() {
  highlightStart = null;
  highlightEnd = null;
  highlightStar.classList.add("hidden");
  timelineHighlight.style.left = "0%";
  timelineHighlight.style.width = "0%";
}

function refreshHighlightUI() {
  renderHighlights();
  renderSavedHighlightMarkers();
}

// ---------- BASIC VIDEO FUNCTIONS ----------
function playVideo() {
  video.play();
}

function pauseVideo() {
  video.pause();
}

function skipBackward() {
  video.currentTime = Math.max(0, video.currentTime - 5);
}

function skipForward() {
  video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
}

function slowerVideo() {
  video.playbackRate = Math.max(0.25, video.playbackRate - 0.25);
  updateSpeedDisplay();
}

function fasterVideo() {
  video.playbackRate = Math.min(3, video.playbackRate + 0.25);
  updateSpeedDisplay();
}

function resetSpeed() {
  video.playbackRate = 1;
  updateSpeedDisplay();
}

function stepFrameBack() {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime - FRAME_STEP);
}

function stepFrameForward() {
  video.pause();
  video.currentTime = Math.min(video.duration || Infinity, video.currentTime + FRAME_STEP);
}

function updateSpeedDisplay() {
  if (speedDisplay) {
    speedDisplay.textContent = `${video.playbackRate}x`;
  }
}

// ---------- LOCAL VIDEO UPLOAD ----------
function loadSelectedVideo(event) {
  const file = event.target.files[0];
  if (!file) return;

  const videoURL = URL.createObjectURL(file);
  video.src = videoURL;
  video.load();

  currentVideo = {
    id: createVideoIdFromFile(file),
    sourceType: "local-upload",
    sourceKey: createVideoIdFromFile(file),
    title: file.name,
    uploadedBy: currentUser.id,
    createdAt: new Date().toISOString(),
    status: "active",
    visibility: "private",
    moderationFlags: [],
  };

  if (videoFileName) {
    videoFileName.textContent = `${file.name} • highlights for this file will reappear when this same file is loaded again`;
  }

  resetInProgressHighlight();
  refreshHighlightUI();
}

videoUpload?.addEventListener("change", loadSelectedVideo);

// ---------- NOTES ----------
function saveNote() {
  const noteText = noteInput.value.trim();
  if (!noteText) return;

  const note = {
    text: noteText,
    time: Number(video.currentTime.toFixed(2)),
  };

  notes.push(note);
  renderNotes();
  noteInput.value = "";
}

function renderNotes() {
  notesList.innerHTML = "";

  notes.forEach((note) => {
    const li = document.createElement("li");
    li.textContent = `[${note.time}s] ${note.text}`;
    notesList.appendChild(li);
  });
}

// ---------- HIGHLIGHTS ----------
function markHighlightStart() {
  highlightStart = video.currentTime;
  highlightEnd = null;

  highlightStar.classList.remove("hidden");
  updateHighlightBar();
}

function markHighlightEnd() {
  if (highlightStart === null) return;

  highlightEnd = video.currentTime;

  if (highlightEnd < highlightStart) {
    const temp = highlightStart;
    highlightStart = highlightEnd;
    highlightEnd = temp;
  }

  highlightStar.classList.add("hidden");
  updateHighlightBar();
}

function saveHighlight() {
  if (highlightStart === null || highlightEnd === null) {
    alert("Mark the start and end of the highlight first.");
    return;
  }

  const now = new Date().toISOString();
  const title =
    highlightTitleInput?.value.trim() ||
    `Highlight ${getCurrentVideoHighlights().length + 1}`;

  const highlight = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    videoId: currentVideo.id,
    videoLabel: currentVideo.title,
    title,
    start: Number(highlightStart.toFixed(2)),
    end: Number(highlightEnd.toFixed(2)),
    createdBy: currentUser.id,
    createdAt: now,
    updatedAt: now,
    clipStatus: "virtual",
    clipUrl: null,
    note: "",
    tags: [],
  };

  allHighlights.push(highlight);
  saveHighlightsToStorage();

  if (highlightTitleInput) {
    highlightTitleInput.value = "";
  }

  resetInProgressHighlight();
  refreshHighlightUI();
}

function playHighlight(highlight) {
  if (highlight.videoId !== currentVideo.id) {
    alert("That highlight belongs to a different video. Load that video first.");
    return;
  }

  video.currentTime = highlight.start;
  video.play();
}

function deleteHighlight(highlightId) {
  allHighlights = allHighlights.filter((highlight) => highlight.id !== highlightId);
  saveHighlightsToStorage();
  refreshHighlightUI();
}

function renderHighlights() {
  const currentHighlights = getCurrentVideoHighlights();
  highlightList.innerHTML = "";

  if (currentHighlights.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No saved highlights for this video yet.";
    highlightList.appendChild(li);
    return;
  }

  currentHighlights.forEach((highlight) => {
    const li = document.createElement("li");

    const titleRow = document.createElement("div");
    titleRow.textContent = `${highlight.title}: ${highlight.start}s → ${highlight.end}s`;
    titleRow.style.cursor = "pointer";
    titleRow.addEventListener("click", () => {
      playHighlight(highlight);
    });

    const metaRow = document.createElement("div");
    metaRow.textContent = `Status: ${highlight.clipStatus}`;
    metaRow.style.marginTop = "8px";
    metaRow.style.fontSize = "0.9rem";
    metaRow.style.opacity = "0.85";

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.style.marginTop = "10px";
    deleteBtn.addEventListener("click", () => {
      deleteHighlight(highlight.id);
    });

    li.appendChild(titleRow);
    li.appendChild(metaRow);
    li.appendChild(deleteBtn);

    highlightList.appendChild(li);
  });
}

function updateHighlightBar() {
  if (!video.duration || highlightStart === null) return;

  const startPercent = (highlightStart / video.duration) * 100;

  if (highlightEnd === null) {
    timelineHighlight.style.left = `${startPercent}%`;
    timelineHighlight.style.width = "1%";
    return;
  }

  const endPercent = (highlightEnd / video.duration) * 100;
  const widthPercent = endPercent - startPercent;

  timelineHighlight.style.left = `${startPercent}%`;
  timelineHighlight.style.width = `${widthPercent}%`;
}

function renderSavedHighlightMarkers() {
  const currentHighlights = getCurrentVideoHighlights();
  timelineSavedHighlights.innerHTML = "";

  if (!video.duration) return;

  currentHighlights.forEach((highlight) => {
    const marker = document.createElement("div");
    marker.className = "timeline-saved-marker";

    const startPercent = (highlight.start / video.duration) * 100;
    const endPercent = (highlight.end / video.duration) * 100;
    const widthPercent = Math.max(endPercent - startPercent, 0.8);

    marker.style.left = `${startPercent}%`;
    marker.style.width = `${widthPercent}%`;
    marker.title = highlight.title;

    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      playHighlight(highlight);
    });

    timelineSavedHighlights.appendChild(marker);
  });
}

// ---------- CLICKABLE TIMELINE ----------
function seekFromTimeline(clientX) {
  if (!video.duration) return;

  const rect = timelineBar.getBoundingClientRect();
  const clickX = clientX - rect.left;
  const percent = Math.min(Math.max(clickX / rect.width, 0), 1);

  video.currentTime = percent * video.duration;
}

timelineBar?.addEventListener("click", (event) => {
  seekFromTimeline(event.clientX);
});

timelineBar?.addEventListener("touchstart", (event) => {
  const touch = event.touches[0];
  if (!touch) return;
  seekFromTimeline(touch.clientX);
});

// ---------- FULLSCREEN ----------
function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (videoWrapper.requestFullscreen) {
      videoWrapper.requestFullscreen();
    } else if (videoWrapper.webkitRequestFullscreen) {
      videoWrapper.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function isWrapperFullscreen() {
  return (
    document.fullscreenElement === videoWrapper ||
    document.webkitFullscreenElement === videoWrapper
  );
}

function showOverlayTemporarily() {
  if (!isWrapperFullscreen()) return;

  fullscreenOverlay.classList.remove("hidden-overlay");
  fullscreenOverlay.classList.add("overlay-visible");

  clearTimeout(overlayTimeout);

  overlayTimeout = setTimeout(() => {
    fullscreenOverlay.classList.add("hidden-overlay");
    fullscreenOverlay.classList.remove("overlay-visible");
  }, 1400);
}

function handleFullscreenChange() {
  if (isWrapperFullscreen()) {
    showOverlayTemporarily();
  } else {
    fullscreenOverlay.classList.add("hidden-overlay");
    fullscreenOverlay.classList.remove("overlay-visible");
  }
}

// ---------- TIMELINE PROGRESS ----------
video.addEventListener("timeupdate", () => {
  if (!video.duration) return;

  const progressPercent = (video.currentTime / video.duration) * 100;
  timelineProgress.style.width = `${progressPercent}%`;
});

video.addEventListener("loadedmetadata", () => {
  renderSavedHighlightMarkers();
});

// ---------- NORMAL BUTTON EVENTS ----------
playBtn?.addEventListener("click", playVideo);
pauseBtn?.addEventListener("click", pauseVideo);
backwardBtn?.addEventListener("click", skipBackward);
forwardBtn?.addEventListener("click", skipForward);

slowerBtn?.addEventListener("click", slowerVideo);
fasterBtn?.addEventListener("click", fasterVideo);
resetSpeedBtn?.addEventListener("click", resetSpeed);

frameBackBtn?.addEventListener("click", stepFrameBack);
frameForwardBtn?.addEventListener("click", stepFrameForward);

fullscreenBtn?.addEventListener("click", toggleFullscreen);

saveNoteBtn?.addEventListener("click", saveNote);

highlightStartBtn?.addEventListener("click", markHighlightStart);
highlightEndBtn?.addEventListener("click", markHighlightEnd);
saveHighlightBtn?.addEventListener("click", saveHighlight);

// ---------- FULLSCREEN OVERLAY BUTTON EVENTS ----------
fsPlayBtn?.addEventListener("click", playVideo);
fsPauseBtn?.addEventListener("click", pauseVideo);
fsBackwardBtn?.addEventListener("click", skipBackward);
fsForwardBtn?.addEventListener("click", skipForward);

fsSlowerBtn?.addEventListener("click", slowerVideo);
fsFasterBtn?.addEventListener("click", fasterVideo);

fsFrameBackBtn?.addEventListener("click", stepFrameBack);
fsFrameForwardBtn?.addEventListener("click", stepFrameForward);

fsFullscreenBtn?.addEventListener("click", toggleFullscreen);

fsHighlightStartBtn?.addEventListener("click", markHighlightStart);
fsHighlightEndBtn?.addEventListener("click", markHighlightEnd);
fsSaveHighlightBtn?.addEventListener("click", saveHighlight);

// ---------- SHOW/HIDE OVERLAY ----------
videoWrapper.addEventListener("mousemove", showOverlayTemporarily);
videoWrapper.addEventListener("touchstart", showOverlayTemporarily);
videoWrapper.addEventListener("click", showOverlayTemporarily);

document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

// ---------- INIT ----------
loadHighlightsFromStorage();
updateSpeedDisplay();
renderNotes();
refreshHighlightUI();