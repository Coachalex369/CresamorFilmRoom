/*
  capture.js — recording workflow.

  Real-Time Sideline Replay pass: the benchmark changed from "fast uploads"
  to instant replay. The Review step is now where that happens — recording
  stops, the local Blob preview plays right there (unchanged mechanic from
  Foundation Sprint Phase 4), and once a team is confirmed the recording is
  handed to the Recording Library and synced in the background while the
  coach keeps watching the SAME preview. There's no more full-screen
  "Uploading…"/"Done" hand-off — closing the modal is how the coach moves
  on, and syncing continues regardless of whether the modal is open.

    Record -> Preview (instant replay) -> Confirm -> Assign Team
      -> handed to recordingLibrary + recordingPipeline (background)
      -> Review keeps playing, small inline status line updates in place

  Capture mechanism still branches by device (unchanged from Phase 4):
    - Mobile (matchMedia('(pointer: coarse)')): native OS camera via
      <input type="file" capture>, toggled between "environment" (back,
      default) and "user" (front) — sidesteps iOS Safari's MediaRecorder
      codec/reliability history entirely.
    - Desktop: in-browser MediaRecorder flow (record/pause/resume/stop) —
      there's no native camera app to hand off to on a laptop.

  This file is a *producer* for the Recording Library — it creates
  recordings and hands them off, but never touches IndexedDB or performs
  the upload itself. See client/recordingLibrary.js (the source of truth
  for every recording, local or synced) and client/recordingPipeline.js
  (the one consumer that moves them to the cloud) — both loaded before this
  file. Full ownership model in ARCHITECTURE.md.

  Loaded after app.js/mockData.js/home.js/recordingLibrary.js/
  recordingPipeline.js. Reuses globals from app.js (API_URL, currentUser,
  showMessage, loadVideos, selectVideo).

  film_type is no longer collected (removed per the Foundation Sprint Phase
  4 brief: "do not ask ... Team Film, Individual Film"). The videos.film_type
  column still exists and still accepts it server-side for backward
  compatibility, but this flow simply doesn't send it.

  The existing manual file-picker upload (#video-upload / uploadVideo() in
  app.js) is completely untouched and remains available as a fallback.
*/

const RECORDING_CONTEXT_KEY = "cresamor_last_recording_context";

const isMobileLikely = window.matchMedia("(pointer: coarse)").matches;

let cachedTeams = null;

async function loadTeams() {
  if (cachedTeams) return cachedTeams;

  try {
    cachedTeams = await apiFetch("/api/teams");
  } catch (error) {
    console.error("Failed to load teams:", error);
    cachedTeams = [];
  }

  return cachedTeams;
}

/* ---------- DOM refs ---------- */

const recordFilmBtn = document.querySelector("#record-film-btn");
const captureModal = document.querySelector("#capture-modal");
const captureCloseBtn = document.querySelector("#capture-close-btn");

const captureSteps = {
  camera: document.querySelector("#capture-step-camera"),
  device: document.querySelector("#capture-step-device"),
  record: document.querySelector("#capture-step-record"),
  review: document.querySelector("#capture-step-review"),
  confirmTeam: document.querySelector("#capture-step-confirm-team"),
};

const captureNativeButtons = document.querySelector("#capture-native-buttons");
const captureNativeBackBtn = document.querySelector("#capture-native-back-btn");
const captureNativeFrontBtn = document.querySelector("#capture-native-front-btn");
const captureNativeInput = document.querySelector("#capture-native-input");
const captureDesktopStart = document.querySelector("#capture-desktop-start");
const captureStartDesktopBtn = document.querySelector("#capture-start-desktop-btn");

const captureDeviceSelect = document.querySelector("#capture-device-select");
const captureDevicePreview = document.querySelector("#capture-device-preview");
const captureContinueToRecordBtn = document.querySelector("#capture-continue-to-record-btn");

const capturePreviewVideo = document.querySelector("#capture-preview-video");
const captureRecordDot = document.querySelector("#capture-record-dot");
const captureRecordTimer = document.querySelector("#capture-record-timer");
const captureRecordBtn = document.querySelector("#capture-record-btn");
const capturePauseBtn = document.querySelector("#capture-pause-btn");
const captureResumeBtn = document.querySelector("#capture-resume-btn");
const captureStopBtn = document.querySelector("#capture-stop-btn");

const captureReviewVideo = document.querySelector("#capture-review-video");
const captureReviewActions = document.querySelector("#capture-review-actions");
const captureDiscardBtn = document.querySelector("#capture-discard-btn");
const captureUseVideoBtn = document.querySelector("#capture-use-video-btn");
const captureReviewStatus = document.querySelector("#capture-review-status");
const captureReviewStatusText = document.querySelector("#capture-review-status-text");
const captureReviewStatusFill = document.querySelector("#capture-review-status-fill");

const captureSuggestedTeam = document.querySelector("#capture-suggested-team");
const captureConfirmSuggestedTeamBtn = document.querySelector("#capture-confirm-suggested-team-btn");
const captureConfirmTeamList = document.querySelector("#capture-confirm-team-list");
const captureSkipTeamBtn = document.querySelector("#capture-skip-team-btn");

/* ---------- state ---------- */

const capture = {
  team: null, // { id, name, sport } | null
  stream: null, // desktop MediaRecorder path only
  recorder: null,
  chunks: [],
  blob: null, // Blob (desktop) or File (native capture)
  timerInterval: null,
  elapsedSeconds: 0,
  mimeType: null,
  recordingId: null, // set once handed to recordingLibrary (after team confirm)
  unsubscribeRecording: null,
};

/* ---------- modal / step helpers ---------- */

function showCaptureStep(stepKey) {
  Object.values(captureSteps).forEach((el) => el.classList.add("hidden"));
  captureSteps[stepKey].classList.remove("hidden");
}

function openCaptureModal() {
  captureModal.classList.remove("hidden");
}

function closeCaptureModal() {
  captureModal.classList.add("hidden");
  teardownCapture();
}

function teardownCapture() {
  if (capture.stream) {
    capture.stream.getTracks().forEach((track) => track.stop());
    capture.stream = null;
  }

  if (capture.timerInterval) {
    clearInterval(capture.timerInterval);
    capture.timerInterval = null;
  }

  // Unsubscribe from the Recording Library's change events — the recording
  // itself (if one was handed off) keeps syncing in the background; this
  // only stops this modal instance from reacting to further updates for it.
  if (capture.unsubscribeRecording) {
    capture.unsubscribeRecording();
    capture.unsubscribeRecording = null;
  }

  capture.recorder = null;
  capture.chunks = [];
  capture.blob = null;
  capture.team = null;
  capture.elapsedSeconds = 0;
  capture.recordingId = null;
  captureRecordTimer.textContent = "00:00";

  if (captureReviewActions) captureReviewActions.classList.remove("hidden");
  if (captureReviewStatus) captureReviewStatus.classList.add("hidden");
}

/* ---------- recording context (smart default for team suggestion) ---------- */

function getLastRecordingContext() {
  try {
    return JSON.parse(localStorage.getItem(RECORDING_CONTEXT_KEY));
  } catch {
    return null;
  }
}

function saveRecordingContext(team) {
  if (!team) {
    localStorage.removeItem(RECORDING_CONTEXT_KEY);
    return;
  }

  localStorage.setItem(RECORDING_CONTEXT_KEY, JSON.stringify({ teamId: team.id }));
}

/* ---------- entry point: straight to the camera, no upfront questions ---------- */

function startCaptureFlow() {
  if (!currentUser) {
    showMessage("You must be logged in to record film.");
    return;
  }

  openCaptureModal();
  showCaptureStep("camera");

  if (isMobileLikely) {
    captureNativeButtons.classList.remove("hidden");
    captureDesktopStart.classList.add("hidden");
  } else {
    captureNativeButtons.classList.add("hidden");
    captureDesktopStart.classList.remove("hidden");
  }
}

/* ---------- mobile path: native camera via file input capture ---------- */

captureNativeBackBtn.addEventListener("click", () => {
  captureNativeInput.setAttribute("capture", "environment");
  captureNativeInput.click();
});

captureNativeFrontBtn.addEventListener("click", () => {
  captureNativeInput.setAttribute("capture", "user");
  captureNativeInput.click();
});

captureNativeInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;

  capture.blob = file;
  captureReviewVideo.src = URL.createObjectURL(file);
  showCaptureStep("review");

  captureNativeInput.value = ""; // allow picking the same file again later
});

/* ---------- desktop path: in-browser MediaRecorder (Sprint 1, unchanged mechanics) ---------- */

captureStartDesktopBtn.addEventListener("click", () => {
  goToDeviceStep();
});

async function goToDeviceStep() {
  showCaptureStep("device");

  try {
    const initialStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    capture.stream = initialStream;
    captureDevicePreview.srcObject = initialStream;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === "videoinput");

    captureDeviceSelect.innerHTML = "";

    videoInputs.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      captureDeviceSelect.appendChild(option);
    });
  } catch (error) {
    console.error("Camera access failed:", error);
    showMessage("Could not access a camera. Check permissions and try again.");
    closeCaptureModal();
  }
}

captureDeviceSelect.addEventListener("change", async () => {
  const deviceId = captureDeviceSelect.value;
  if (!deviceId) return;

  if (capture.stream) {
    capture.stream.getTracks().forEach((track) => track.stop());
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: true,
    });

    capture.stream = stream;
    captureDevicePreview.srcObject = stream;
  } catch (error) {
    console.error("Failed to switch camera:", error);
    showMessage("Could not switch to that camera.");
  }
});

captureContinueToRecordBtn.addEventListener("click", () => {
  capturePreviewVideo.srcObject = capture.stream;
  showCaptureStep("record");
});

function pickSupportedMimeType() {
  // Real-Time Sideline Replay: MP4/H.264 preferred first (broadest
  // compatibility, minimizes future FFmpeg need), WebM as fallback — most
  // desktop MediaRecorder implementations only support WebM today, so this
  // still ends up on WebM in practice there, but Safari's does support MP4
  // and should take it.
  const candidates = [
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
}

// Production bug fix: MediaRecorder happily accepts the loose
// "video/mp4;codecs=avc1,mp4a" syntax (needed to pick the right encoder),
// but that same string is NOT a spec-valid Blob/Content-Type value — the
// unquoted comma inside the codecs parameter isn't legal token/quoted-
// string syntax. Blob.prototype.type stores it faithfully either way, but
// browsers silently drop it when generating the real multipart Content-
// Type header for the upload, and the server ends up seeing "text/plain"
// (busboy's default for a part with no Content-Type at all) instead of
// any recognizable video type — every desktop recording using a
// codec-qualified candidate failed the server's MIME allowlist as a
// result. Only the base container type ("video/mp4"/"video/webm") is
// ever needed downstream (server-side validation, extension lookup); the
// codec parameter's job ends once MediaRecorder has been constructed.
function baseMimeType(mimeType) {
  return (mimeType || "").split(";")[0].trim();
}

function formatTimer(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function startTimer() {
  capture.elapsedSeconds = 0;
  captureRecordTimer.textContent = "00:00";

  capture.timerInterval = setInterval(() => {
    capture.elapsedSeconds += 1;
    captureRecordTimer.textContent = formatTimer(capture.elapsedSeconds);
  }, 1000);
}

function stopTimer() {
  if (capture.timerInterval) {
    clearInterval(capture.timerInterval);
    capture.timerInterval = null;
  }
}

captureRecordBtn.addEventListener("click", () => {
  capture.mimeType = pickSupportedMimeType();
  capture.chunks = [];

  // Capture-time quality control: constrained resolution (set when the
  // stream was acquired) + capped bitrate here — this is the whole
  // "compression" strategy (no ffmpeg, no deployment changes).
  const options = capture.mimeType
    ? { mimeType: capture.mimeType, videoBitsPerSecond: 2_500_000 }
    : { videoBitsPerSecond: 2_500_000 };

  try {
    capture.recorder = new MediaRecorder(capture.stream, options);
  } catch (error) {
    console.error("MediaRecorder init failed:", error);
    showMessage("Recording isn't supported in this browser.");
    return;
  }

  capture.recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      capture.chunks.push(event.data);
    }
  };

  capture.recorder.onstop = () => {
    capture.blob = new Blob(capture.chunks, { type: baseMimeType(capture.mimeType) || "video/webm" });
    captureReviewVideo.src = URL.createObjectURL(capture.blob);
    showCaptureStep("review");
  };

  capture.recorder.start();
  startTimer();

  captureRecordDot.classList.remove("hidden");
  captureRecordBtn.classList.add("hidden");
  capturePauseBtn.classList.remove("hidden");
  captureStopBtn.classList.remove("hidden");
});

capturePauseBtn.addEventListener("click", () => {
  if (capture.recorder && capture.recorder.state === "recording") {
    capture.recorder.pause();
    stopTimer();
    capturePauseBtn.classList.add("hidden");
    captureResumeBtn.classList.remove("hidden");
  }
});

captureResumeBtn.addEventListener("click", () => {
  if (capture.recorder && capture.recorder.state === "paused") {
    capture.recorder.resume();
    capture.timerInterval = setInterval(() => {
      capture.elapsedSeconds += 1;
      captureRecordTimer.textContent = formatTimer(capture.elapsedSeconds);
    }, 1000);
    captureResumeBtn.classList.add("hidden");
    capturePauseBtn.classList.remove("hidden");
  }
});

captureStopBtn.addEventListener("click", () => {
  if (capture.recorder && capture.recorder.state !== "inactive") {
    capture.recorder.stop();
  }

  stopTimer();
  captureRecordDot.classList.add("hidden");
  captureRecordBtn.classList.remove("hidden");
  capturePauseBtn.classList.add("hidden");
  captureResumeBtn.classList.add("hidden");
  captureStopBtn.classList.add("hidden");
});

/* ---------- review ---------- */

captureDiscardBtn.addEventListener("click", () => {
  capture.blob = null;
  capture.chunks = [];
  captureReviewVideo.removeAttribute("src");

  if (capture.stream) {
    // Desktop path — camera's still open, go straight back to recording.
    capturePreviewVideo.srcObject = capture.stream;
    showCaptureStep("record");
  } else {
    // Native/mobile path — nothing to resume, start over from the camera step.
    startCaptureFlow();
  }
});

captureUseVideoBtn.addEventListener("click", () => {
  showConfirmTeamStep();
});

/* ---------- assign team (after preview, per the desired flow) ---------- */

async function showConfirmTeamStep() {
  showCaptureStep("confirmTeam");

  const teams = await loadTeams();
  const context = getLastRecordingContext();
  const suggestedTeam = context ? teams.find((t) => t.id === context.teamId) : null;

  if (suggestedTeam) {
    captureSuggestedTeam.classList.remove("hidden");
    captureConfirmSuggestedTeamBtn.textContent = `✓ Confirm: ${suggestedTeam.name}`;

    captureConfirmSuggestedTeamBtn.onclick = () => {
      capture.team = suggestedTeam;
      syncRecording();
    };
  } else {
    captureSuggestedTeam.classList.add("hidden");
  }

  captureConfirmTeamList.innerHTML = "";

  teams
    .filter((t) => !suggestedTeam || t.id !== suggestedTeam.id)
    .forEach((team) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");

      btn.type = "button";
      btn.className = "capture-team-btn";
      btn.textContent = team.sport ? `${team.name} (${team.sport})` : team.name;

      btn.addEventListener("click", () => {
        capture.team = team;
        syncRecording();
      });

      li.appendChild(btn);
      captureConfirmTeamList.appendChild(li);
    });

  if (!teams.length) {
    captureConfirmTeamList.innerHTML = "<li>No teams yet — an admin needs to create one.</li>";
  }
}

captureSkipTeamBtn.addEventListener("click", () => {
  capture.team = null;
  syncRecording();
});

/* ---------- sync: hand the recording to the Recording Library, stay on Review ---------- */

function buildRecordingTitle() {
  const teamLabel = capture.team ? capture.team.name : "No Team";
  const stamp = new Date().toLocaleString();
  return `${teamLabel} — ${stamp}`;
}

function renderRecordingStatus(record) {
  if (!captureReviewStatus || !record) return;

  captureReviewStatus.classList.remove("hidden");

  if (record.lifecycle === "local") {
    // Reverted to local — either still queued for a first attempt, or a
    // previous attempt failed and it's waiting to retry.
    captureReviewStatusText.textContent = record.lastError
      ? "Sync paused — will retry automatically."
      : "Waiting to sync…";
    captureReviewStatusFill.style.width = "0%";
  } else if (record.lifecycle === "uploading") {
    captureReviewStatusText.textContent = `Syncing to ${
      capture.team ? capture.team.name : "library"
    }… ${record.uploadProgress || 0}%`;
    captureReviewStatusFill.style.width = `${record.uploadProgress || 0}%`;
  } else if (record.lifecycle === "synced" || record.lifecycle === "processed") {
    captureReviewStatusText.textContent = "Synced ✓";
    captureReviewStatusFill.style.width = "100%";
  }
}

// This is the actual instant-replay moment: the recording is handed off to
// the Recording Library (persisted to IndexedDB — safe even if the modal
// is closed or the tab dies) and enqueued with recordingPipeline, but we
// deliberately do NOT navigate away or show a blocking "Uploading…" step.
// The review video (already playing the local Blob) keeps playing exactly
// as it was; a small inline status line takes over from the Discard/Use
// Video buttons and updates itself via recordingLibrary.subscribe() as the
// sync progresses in the background.
async function syncRecording() {
  if (!capture.blob) return;

  saveRecordingContext(capture.team);

  const record = await recordingLibrary.create({
    blob: capture.blob,
    title: buildRecordingTitle(),
    teamId: capture.team ? capture.team.id : null,
    uploadedBy: currentUser.id,
  });

  capture.recordingId = record.recordingId;

  if (captureReviewActions) captureReviewActions.classList.add("hidden");
  renderRecordingStatus(record);

  capture.unsubscribeRecording = recordingLibrary.subscribe(({ recordingId, record: updated }) => {
    if (recordingId !== capture.recordingId) return;
    renderRecordingStatus(updated);
  });

  showCaptureStep("review");
  recordingPipeline.enqueue(record.recordingId);
}

/* ---------- open/close wiring ---------- */

if (recordFilmBtn) {
  recordFilmBtn.addEventListener("click", startCaptureFlow);
}

captureCloseBtn.addEventListener("click", closeCaptureModal);
