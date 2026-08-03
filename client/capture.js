/*
  capture.js — Phase 2: recording workflow using MediaDevices/MediaRecorder.

  Loaded after app.js/mockData.js/home.js. Reuses globals from app.js
  (API_URL, currentUser, showMessage, loadVideos, selectVideo) plus MOCK_TEAMS
  from mockData.js (no real teams backend exists yet).

  IMPORTANT — persistence limitation: film_type/team choice CANNOT be stored
  server-side without a schema change (out of scope this session). It's kept
  as client-side metadata only, folded into the uploaded video's title, e.g.
  "Practice Cuts — Team Film — Cresamor Wrestling". This is a documented
  known limitation, not a bug.

  The existing manual file-picker upload (#video-upload / uploadVideo() in
  app.js) is completely untouched and remains available as a fallback.
*/

const RECORDING_CONTEXT_KEY = "cresamor_last_recording_context";

/* ---------- DOM refs ---------- */

const recordFilmBtn = document.querySelector("#record-film-btn");
const captureModal = document.querySelector("#capture-modal");
const captureCloseBtn = document.querySelector("#capture-close-btn");

const captureSteps = {
  context: document.querySelector("#capture-step-context"),
  picker: document.querySelector("#capture-step-picker"),
  device: document.querySelector("#capture-step-device"),
  record: document.querySelector("#capture-step-record"),
  review: document.querySelector("#capture-step-review"),
  upload: document.querySelector("#capture-step-upload"),
  done: document.querySelector("#capture-step-done"),
};

const captureContextQuestion = document.querySelector("#capture-context-question");
const captureContextYesBtn = document.querySelector("#capture-context-yes-btn");
const captureContextNoBtn = document.querySelector("#capture-context-no-btn");

const captureTypeTeamBtn = document.querySelector("#capture-type-team-btn");
const captureTypeIndividualBtn = document.querySelector("#capture-type-individual-btn");
const captureTeamChoice = document.querySelector("#capture-team-choice");
const captureTeamList = document.querySelector("#capture-team-list");

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
const captureUploadBtn = document.querySelector("#capture-upload-btn");

const captureUploadStatusText = document.querySelector("#capture-upload-status-text");
const captureUploadProgressFill = document.querySelector("#capture-upload-progress-fill");

const captureDoneBtn = document.querySelector("#capture-done-btn");

/* ---------- state ---------- */

const capture = {
  filmType: null, // 'team' | 'individual'
  team: null, // { id, name, sport } | null
  stream: null,
  recorder: null,
  chunks: [],
  blob: null,
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
  capture.elapsedSeconds = 0;
  captureRecordTimer.textContent = "00:00";
}

/* ---------- entry point: context-aware start ---------- */

function getLastRecordingContext() {
  try {
    return JSON.parse(localStorage.getItem(RECORDING_CONTEXT_KEY));
  } catch {
    return null;
  }
}

function saveRecordingContext(sport, team) {
  localStorage.setItem(
    RECORDING_CONTEXT_KEY,
    JSON.stringify({ sport, teamName: team ? team.name : null })
  );
}

function startCaptureFlow() {
  if (!currentUser) {
    showMessage("You must be logged in to record film.");
    return;
  }

  openCaptureModal();

  const context = getLastRecordingContext();

  if (context && context.sport === "wrestling") {
    const team = MOCK_TEAMS.find((t) => t.sport === "wrestling") || null;
    captureContextQuestion.textContent = "Record for Wrestling?";
    showCaptureStep("context");

    captureContextYesBtn.onclick = () => {
      capture.filmType = "individual";
      capture.team = team;
      goToDeviceStep();
    };

    captureContextNoBtn.onclick = () => {
      showPickerStep();
    };

    return;
  }

  if (context && context.sport === "football") {
    const team = MOCK_TEAMS.find((t) => t.sport === "football") || null;
    captureContextQuestion.textContent = "Record for Football (Team Film)?";
    showCaptureStep("context");

    captureContextYesBtn.onclick = () => {
      capture.filmType = "team";
      capture.team = team;
      goToDeviceStep();
    };

    captureContextNoBtn.onclick = () => {
      showPickerStep();
    };

    return;
  }

  showPickerStep();
}

/* ---------- picker step: Team Film / Individual Film + Choose Team ---------- */

function showPickerStep() {
  captureTeamChoice.classList.add("hidden");
  showCaptureStep("picker");
}

function renderTeamList() {
  captureTeamList.innerHTML = "";

  MOCK_TEAMS.forEach((team) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");

    btn.type = "button";
    btn.className = "capture-team-btn";
    btn.textContent = `${team.name} (${team.sport})`;

    btn.addEventListener("click", () => {
      capture.team = team;
      goToDeviceStep();
    });

    li.appendChild(btn);
    captureTeamList.appendChild(li);
  });
}

captureTypeTeamBtn.addEventListener("click", () => {
  capture.filmType = "team";
  renderTeamList();
  captureTeamChoice.classList.remove("hidden");
});

captureTypeIndividualBtn.addEventListener("click", () => {
  capture.filmType = "individual";
  renderTeamList();
  captureTeamChoice.classList.remove("hidden");
});

/* ---------- device step ---------- */

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

/* ---------- recording ---------- */

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
  // "compression" strategy for Sprint 1 (no ffmpeg, no deployment changes).
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
  capturePreviewVideo.srcObject = capture.stream;
  showCaptureStep("record");
});

captureUploadBtn.addEventListener("click", () => {
  uploadRecording();
});

/* ---------- upload (reuses the existing /api/upload-video endpoint) ---------- */

function buildRecordingTitle() {
  const typeLabel = capture.filmType === "team" ? "Team Film" : "Individual Film";
  const teamLabel = capture.team ? capture.team.name : "No Team Selected";
  const stamp = new Date().toLocaleString();

  // film_type/team can't be persisted as real columns without a schema
  // change (out of scope this session) — folding them into the title is
  // the documented client-side-metadata workaround.
  return `${typeLabel} — ${teamLabel} — ${stamp}`;
}

function uploadRecording() {
  if (!capture.blob) return;

  showCaptureStep("upload");
  captureUploadStatusText.textContent = "Uploading…";
  captureUploadProgressFill.style.width = "0%";

  const formData = new FormData();
  const extension = (capture.mimeType || "video/webm").includes("mp4") ? "mp4" : "webm";

  formData.append("video", capture.blob, `recording-${Date.now()}.${extension}`);
  formData.append("title", buildRecordingTitle());
  formData.append("uploaded_by", currentUser.id);

  const xhr = new XMLHttpRequest();

  xhr.open("POST", `${API_URL}/api/upload-video`);

  xhr.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      captureUploadProgressFill.style.width = `${percent}%`;
    }
  });

  xhr.addEventListener("load", () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      captureUploadStatusText.textContent = "Processing…";

      if (capture.team) {
        saveRecordingContext(capture.team.sport, capture.team);
      }

      setTimeout(async () => {
        showCaptureStep("done");

        try {
          const uploaded = JSON.parse(xhr.responseText);
          await loadVideos();
          selectVideo(uploaded);
        } catch (error) {
          console.error("Post-upload refresh failed:", error);
        }
      }, 400);
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
