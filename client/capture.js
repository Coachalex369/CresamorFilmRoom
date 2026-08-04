/*
  capture.js — recording workflow.

  Foundation Sprint Phase 4: rewritten around "should feel like opening the
  phone camera." Removed the upfront Wrestling/Football yes-no question and
  the Team Film/Individual Film choice entirely — recording starts
  immediately on tap. Team assignment moved to AFTER preview, matching:

    Record -> Preview -> Confirm -> Assign Team -> Upload -> Done

  Capture mechanism now branches by device:
    - Mobile (matchMedia('(pointer: coarse)')): native OS camera via
      <input type="file" capture>, toggled between "environment" (back,
      default) and "user" (front). This is a deliberate technical choice,
      not a shortcut — iOS Safari's MediaRecorder support has a real
      history of codec/reliability problems, and handing off to the native
      camera app sidesteps all of that entirely while also being *less*
      code than driving an in-browser recorder. See the Foundation Sprint
      architecture-review response for the full reasoning.
    - Desktop: kept the Sprint 1 in-browser MediaRecorder flow (record/
      pause/resume/stop) — there's no native camera app to hand off to on
      a laptop.

  Both paths converge on the same Preview -> Assign Team -> Upload steps.

  Loaded after app.js/mockData.js/home.js. Reuses globals from app.js
  (API_URL, currentUser, showMessage, loadVideos, selectVideo).

  film_type is no longer collected (explicitly removed per this phase's
  brief: "do not ask ... Team Film, Individual Film"). The videos.film_type
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
  upload: document.querySelector("#capture-step-upload"),
  done: document.querySelector("#capture-step-done"),
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
const captureDiscardBtn = document.querySelector("#capture-discard-btn");
const captureUseVideoBtn = document.querySelector("#capture-use-video-btn");

const captureSuggestedTeam = document.querySelector("#capture-suggested-team");
const captureConfirmSuggestedTeamBtn = document.querySelector("#capture-confirm-suggested-team-btn");
const captureConfirmTeamList = document.querySelector("#capture-confirm-team-list");
const captureSkipTeamBtn = document.querySelector("#capture-skip-team-btn");

const captureUploadStatusText = document.querySelector("#capture-upload-status-text");
const captureUploadProgressFill = document.querySelector("#capture-upload-progress-fill");

const captureDoneBtn = document.querySelector("#capture-done-btn");

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

  capture.recorder = null;
  capture.chunks = [];
  capture.blob = null;
  capture.team = null;
  capture.elapsedSeconds = 0;
  captureRecordTimer.textContent = "00:00";
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
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];

  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
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
    capture.blob = new Blob(capture.chunks, { type: capture.mimeType || "video/webm" });
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
      uploadRecording();
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
        uploadRecording();
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
  uploadRecording();
});

/* ---------- upload (reuses the existing /api/upload-video endpoint) ---------- */

// Foundation Sprint Phase 3: polls the real processing_status instead of
// assuming a fixed delay means "ready" — see server/services/videoProcessing.js.
async function pollVideoUntilReady(videoId, onStatus, { intervalMs = 500, timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const video = await apiFetch(`/api/videos/${videoId}`);

    if (onStatus) onStatus(video.processing_status);

    if (video.processing_status === "ready") return video;
    if (video.processing_status === "failed") throw new Error("Video processing failed");

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Video processing timed out");
}

function buildRecordingTitle() {
  const teamLabel = capture.team ? capture.team.name : "No Team";
  const stamp = new Date().toLocaleString();
  return `${teamLabel} — ${stamp}`;
}

function uploadRecording() {
  if (!capture.blob) return;

  showCaptureStep("upload");
  captureUploadStatusText.textContent = "Uploading…";
  captureUploadProgressFill.style.width = "0%";

  const formData = new FormData();
  const isNativeFile = typeof File !== "undefined" && capture.blob instanceof File;
  const extension = (capture.mimeType || "video/webm").includes("mp4") ? "mp4" : "webm";
  const filename = isNativeFile ? capture.blob.name : `recording-${Date.now()}.${extension}`;

  formData.append("video", capture.blob, filename);
  formData.append("title", buildRecordingTitle());
  formData.append("uploaded_by", currentUser.id);
  // film_type intentionally not sent — removed from this flow per the
  // Foundation Sprint Phase 4 brief ("do not ask ... Team Film, Individual
  // Film"). The column still exists server-side for backward compatibility.
  if (capture.team) {
    formData.append("team_id", capture.team.id);
  }

  const xhr = new XMLHttpRequest();

  xhr.open("POST", `${API_URL}/api/upload-video`);

  xhr.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      captureUploadProgressFill.style.width = `${percent}%`;
    }
  });

  xhr.addEventListener("load", async () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      saveRecordingContext(capture.team);

      try {
        const uploaded = JSON.parse(xhr.responseText);

        const ready = await pollVideoUntilReady(uploaded.id, (status) => {
          captureUploadStatusText.textContent =
            status === "processing" ? "Processing…" : "Uploading…";
        });

        showCaptureStep("done");
        await loadVideos();
        selectVideo(ready);
      } catch (error) {
        console.error("Processing failed or timed out:", error);
        showMessage(
          "Upload succeeded, but processing is taking longer than expected. It'll appear in Film Room once it's ready."
        );
        showCaptureStep("done");
      }
    } else {
      console.error("Upload failed:", xhr.status, xhr.responseText);
      showMessage("Upload failed. Please try again.");
      showCaptureStep("review");
    }
  });

  xhr.addEventListener("error", () => {
    showMessage("Upload failed. Check your connection and try again.");
    showCaptureStep("review");
  });

  xhr.send(formData);
}

captureDoneBtn.addEventListener("click", () => {
  closeCaptureModal();
  switchToScreen("film-screen");
});

/* ---------- open/close wiring ---------- */

if (recordFilmBtn) {
  recordFilmBtn.addEventListener("click", startCaptureFlow);
}

captureCloseBtn.addEventListener("click", closeCaptureModal);
