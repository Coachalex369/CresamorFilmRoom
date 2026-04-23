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
const filmPlayer = document.querySelector("#film-player");
const videoUploadInput = document.querySelector("#video-upload");
const videoList = document.querySelector("#video-list");

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

function selectVideo(video) {
  if (!video) return;

  currentVideoId = video.id;
  filmPlayer.src = video.file_url;
  filmPlayer.load();
  renderVideoList();
  renderCurrentVideoHighlights();
}

function renderVideoList() {
  videoList.innerHTML = "";

  allVideos.forEach((video) => {
    const li = document.createElement("li");
    const button = document.createElement("button");

    button.className = "video-item-btn";
    if (video.id === currentVideoId) {
      button.classList.add("active");
    }

    button.textContent = video.title;
    button.addEventListener("click", () => {
      selectVideo(video);
    });

    li.appendChild(button);
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
      <small>${Number(clip.start_time).toFixed(1)}s - ${Number(clip.end_time).toFixed(1)}s${
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
    const response = await fetch("/api/videos");
    const videos = await response.json();

    if (!response.ok) {
      throw new Error(videos.error || "Failed to load videos");
    }

    if (!Array.isArray(videos) || videos.length === 0) {
      videoList.innerHTML = "<li>No videos found.</li>";
      showMessage("No videos found in database.");
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
    const response = await fetch(`/api/users/${currentUser.id}/clips`);
    const clips = await response.json();

    if (!response.ok) {
      throw new Error(clips.error || "Failed to load clips");
    }

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

  filmPlayer.removeAttribute("src");
  filmPlayer.load();

  if (videoUploadInput) {
    videoUploadInput.value = "";
  }
}

async function loginUser(email, password) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Login failed");
  }

  return data;
}

async function registerUser(email, password, role) {
  const response = await fetch("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, role }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Registration failed");
  }

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
    const response = await fetch("/api/clips", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        start_time: clipStartTime,
        end_time: clipEndTime,
        video_id: currentVideoId,
        user_id: currentUser.id,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to save highlight");
    }

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

async function uploadVideo(file) {
  if (!currentUser || currentUser.role !== "coach") {
    showMessage("Only coaches can upload videos.");
    return;
  }

  if (!file) {
    showMessage("Please choose a video file.");
    return;
  }

  try {
    const formData = new FormData();
    formData.append("video", file);
    formData.append("title", file.name);
    formData.append("uploaded_by", currentUser.id);

    const response = await fetch("/api/upload-video", {
      method: "POST",
      body: formData,
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Non-JSON response:", text);
      throw new Error("Server returned HTML instead of JSON");
    }

    if (!response.ok) {
      throw new Error(data.error || "Failed to upload video");
    }

    showMessage("Video uploaded.");
    await loadVideos();
    selectVideo(data);
    if (videoUploadInput) {
      videoUploadInput.value = "";
    }
  } catch (error) {
    console.error("Upload failed:", error);
    showMessage(error.message || "Could not upload video.");
  }
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
  try {
    await filmPlayer.play();
  } catch (error) {
    console.error("Play failed:", error);
    showMessage("Could not play video.");
  }
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
  } catch (error) {
    console.error("Fullscreen failed:", error);
  }
});

/* ---------- UPLOAD ---------- */

if (videoUploadInput) {
  videoUploadInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    uploadVideo(file);
  });
}

updateSpeedDisplay();
restoreSession();