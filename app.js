const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");

const emailInput = document.querySelector("#email-input");
const passwordInput = document.querySelector("#password-input");

const loginCoachBtn = document.querySelector("#login-coach-btn");
const loginAthleteBtn = document.querySelector("#login-athlete-btn");

const currentRoleLabel = document.querySelector("#current-role-label");

const video = document.querySelector("#film-player");
const videoWrapper = document.querySelector("#video-wrapper");
const videoUpload = document.querySelector("#video-upload");

const coachOnlySections = document.querySelectorAll(".coach-only");

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

const highlightTitleInput = document.querySelector("#highlight-title-input");
const highlightStartBtn = document.querySelector("#highlight-start-btn");
const highlightEndBtn = document.querySelector("#highlight-end-btn");
const saveHighlightBtn = document.querySelector("#save-highlight-btn");
const snapshotBtn = document.querySelector("#snapshot-btn");

const highlightsList = document.querySelector("#highlights-list");
const myHighlightsList = document.querySelector("#my-highlights-list");
const snapshotsList = document.querySelector("#snapshots-list");

const noteInput = document.querySelector("#note-input");
const saveNoteBtn = document.querySelector("#save-note-btn");
const notesList = document.querySelector("#notes-list");

const drawCanvas = document.querySelector("#draw-canvas");
const drawToggleBtn = document.querySelector("#draw-toggle-btn");
const drawLineBtn = document.querySelector("#draw-line-btn");
const drawCircleBtn = document.querySelector("#draw-circle-btn");
const clearDrawingsBtn = document.querySelector("#clear-drawings-btn");

const ctx = drawCanvas.getContext("2d");

let currentRole = null;

let highlightStart = null;
let highlightEnd = null;

let currentVideoHighlights = [];
let myHighlights = [];
let snapshots = [];
let notes = [];

let drawEnabled = false;
let drawTool = "line";
let isDrawing = false;
let startX = 0;
let startY = 0;

function loginAs(role) {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    alert("Enter an email and password.");
    return;
  }

  currentRole = role;

  document.body.classList.add("app-active");
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");

  updateRoleUI();
}

function syncCanvasSize() {
  drawCanvas.width = video.clientWidth;
  drawCanvas.height = video.clientHeight;
}

function updateRoleUI() {
  coachOnlySections.forEach((section) => {
    section.style.display = currentRole === "coach" ? "block" : "none";
  });

  currentRoleLabel.textContent =
    currentRole === "coach" ? "Coach" : "Athlete / Parent";
}

video.addEventListener("loadedmetadata", syncCanvasSize);
window.addEventListener("resize", syncCanvasSize);

if (videoUpload) {
  videoUpload.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    video.load();

    currentVideoHighlights = [];
    renderCurrentVideoHighlights();
  });
}

playBtn.addEventListener("click", () => video.play());
pauseBtn.addEventListener("click", () => video.pause());

backwardBtn.addEventListener("click", () => {
  video.currentTime = Math.max(0, video.currentTime - 5);
});

forwardBtn.addEventListener("click", () => {
  video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
});

slowerBtn.addEventListener("click", () => {
  video.playbackRate = Math.max(0.1, video.playbackRate - 0.25);
  updateSpeedDisplay();
});

fasterBtn.addEventListener("click", () => {
  video.playbackRate = Math.min(3, video.playbackRate + 0.25);
  updateSpeedDisplay();
});

resetSpeedBtn.addEventListener("click", () => {
  video.playbackRate = 1;
  updateSpeedDisplay();
});

frameBackBtn.addEventListener("click", () => {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime - 1 / 30);
});

frameForwardBtn.addEventListener("click", () => {
  video.pause();
  video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 30);
});

fullscreenBtn.addEventListener("click", () => {
  if (videoWrapper.requestFullscreen) {
    videoWrapper.requestFullscreen();
  }
});

function updateSpeedDisplay() {
  speedDisplay.textContent = `${video.playbackRate.toFixed(2)}x`;
}

highlightStartBtn.addEventListener("click", () => {
  highlightStart = video.currentTime;
});

highlightEndBtn.addEventListener("click", () => {
  highlightEnd = video.currentTime;
});

saveHighlightBtn.addEventListener("click", () => {
  if (highlightStart === null || highlightEnd === null) {
    alert("Set both a start and end time first.");
    return;
  }

  if (highlightEnd <= highlightStart) {
    alert("End time must be after start time.");
    return;
  }

  const highlight = {
    id: Date.now(),
    title:
      highlightTitleInput.value.trim() || `Highlight ${myHighlights.length + 1}`,
    start: highlightStart,
    end: highlightEnd,
    owner: currentRole === "coach" ? "Coach" : "Athlete / Parent",
  };

  currentVideoHighlights.push(highlight);
  myHighlights.push(highlight);

  renderCurrentVideoHighlights();
  renderMyHighlights();

  highlightStart = null;
  highlightEnd = null;
  highlightTitleInput.value = "";
});

snapshotBtn.addEventListener("click", () => {
  const snapshot = {
    id: Date.now(),
    time: video.currentTime,
  };

  snapshots.push(snapshot);
  renderSnapshots();
});

function renderCurrentVideoHighlights() {
  highlightsList.innerHTML = "";

  currentVideoHighlights.forEach((highlight) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");

    btn.textContent = `${highlight.title} (${highlight.start.toFixed(
      1
    )}s - ${highlight.end.toFixed(1)}s)`;

    btn.addEventListener("click", () => {
      video.currentTime = highlight.start;
      video.play();
    });

    li.appendChild(btn);
    highlightsList.appendChild(li);
  });
}

function renderMyHighlights() {
  myHighlightsList.innerHTML = "";

  myHighlights.forEach((highlight) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");

    btn.textContent = `${highlight.title} [${highlight.owner}]`;

    btn.addEventListener("click", () => {
      video.currentTime = highlight.start;
      video.play();
    });

    li.appendChild(btn);
    myHighlightsList.appendChild(li);
  });
}

function renderSnapshots() {
  snapshotsList.innerHTML = "";

  snapshots.forEach((snapshot, index) => {
    const li = document.createElement("li");
    li.textContent = `Snapshot ${index + 1} at ${snapshot.time.toFixed(1)}s`;
    snapshotsList.appendChild(li);
  });
}

if (saveNoteBtn) {
  saveNoteBtn.addEventListener("click", () => {
    const value = noteInput.value.trim();
    if (!value) return;

    notes.push(value);
    noteInput.value = "";
    renderNotes();
  });
}

function renderNotes() {
  notesList.innerHTML = "";

  notes.forEach((note) => {
    const li = document.createElement("li");
    li.textContent = note;
    notesList.appendChild(li);
  });
}

drawToggleBtn.addEventListener("click", () => {
  drawEnabled = !drawEnabled;
  drawToggleBtn.textContent = drawEnabled ? "Disable Draw" : "Enable Draw";
});

drawLineBtn.addEventListener("click", () => {
  drawTool = "line";
});

drawCircleBtn.addEventListener("click", () => {
  drawTool = "circle";
});

clearDrawingsBtn.addEventListener("click", () => {
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
});

drawCanvas.addEventListener("mousedown", (event) => {
  if (!drawEnabled || currentRole !== "coach") return;

  isDrawing = true;
  const rect = drawCanvas.getBoundingClientRect();
  startX = event.clientX - rect.left;
  startY = event.clientY - rect.top;
});

drawCanvas.addEventListener("mouseup", (event) => {
  if (!drawEnabled || currentRole !== "coach" || !isDrawing) return;

  isDrawing = false;
  const rect = drawCanvas.getBoundingClientRect();
  const endX = event.clientX - rect.left;
  const endY = event.clientY - rect.top;

  ctx.lineWidth = 3;
  ctx.strokeStyle = "#39ff14";

  if (drawTool === "line") {
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }

  if (drawTool === "circle") {
    const radius = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    ctx.beginPath();
    ctx.arc(startX, startY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
});

document.body.classList.remove("app-active");
appShell.classList.add("hidden");
updateSpeedDisplay();

loginCoachBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    alert("Enter email and password");
    return;
  }

  try {
    const res = await fetch("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (res.ok) {
      console.log("Login success:", data);

      // Save token
      localStorage.setItem("token", data.token);

      currentRole = data.user.role;

      document.body.classList.add("app-active");
      loginScreen.classList.add("hidden");
      appShell.classList.remove("hidden");

      updateRoleUI();
    } else {
      alert(data.error);
    }
  } catch (err) {
    console.error(err);
    alert("Login failed");
  }
});