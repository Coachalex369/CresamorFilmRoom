/*
  home.js — Home screen: profile, hero card, featured reel, continue watching,
  messages preview, upcoming events, recent activity.

  Loaded after app.js and mockData.js via <script> tags (no bundler/module
  system in this project) — reuses globals declared there: API_URL, apiFetch,
  currentUser, filmPlayer, selectVideo, logoutLocalState, activateApp.

  Data sources, by section (see CLAUDE.md for the full breakdown):
    - Profile: REAL data as of Sprint 3 — GET/PUT /api/users/:id/profile,
      photo via POST /api/users/:id/photo. No more localStorage overrides.
    - Hero Card new-highlights count: REAL data (clips created in last 7d).
      Next-event / coach-notification text: MOCK (mockData.js).
    - Featured Reel: REAL clips + videos, thumbnails generated client-side.
    - Continue Watching: localStorage only (still — see CLAUDE.md, this one
      is a deliberate exception since it's inherently session/UX state).
    - Messages Preview: reads #message-thread, which messages.js now
      populates from REAL data (GET /api/messages) instead of a fake thread.
    - Upcoming Events: REAL data as of Phase 3 (Home Integration) --
      GET /api/users/:id/upcoming-events.
    - Recent Activity: REAL videos/clips, padded with MOCK fallback entries
      only when real activity is sparse.
*/

/* ---------- DOM refs ---------- */

const profilePicturePlaceholder = document.querySelector("#profile-picture-placeholder");
const profileName = document.querySelector("#profile-name");
const profileSchool = document.querySelector("#profile-school");
const profileTeam = document.querySelector("#profile-team");
const profileGradYear = document.querySelector("#profile-grad-year");
const editProfileBtn = document.querySelector("#edit-profile-btn");
const editProfileForm = document.querySelector("#edit-profile-form");
const editProfileNameInput = document.querySelector("#edit-profile-name");
const editProfileSchoolInput = document.querySelector("#edit-profile-school");
const editProfileTeamInput = document.querySelector("#edit-profile-team");
const editProfileGradYearInput = document.querySelector("#edit-profile-grad-year");
const saveProfileBtn = document.querySelector("#save-profile-btn");
const cancelProfileBtn = document.querySelector("#cancel-profile-btn");
const editProfilePhotoUpload = document.querySelector("#edit-profile-photo-upload");
const editProfilePhotoCamera = document.querySelector("#edit-profile-photo-camera");
const editProfilePhotoPreview = document.querySelector("#edit-profile-photo-preview");
const editProfilePhotoStatus = document.querySelector("#edit-profile-photo-status");

const videoLoadingOverlay = document.querySelector("#video-loading-overlay");
const videoLoadingProgressFill = document.querySelector("#video-loading-progress-fill");
const videoLoadingPercent = document.querySelector("#video-loading-percent");
const videoLoadingEta = document.querySelector("#video-loading-eta");

const reelLoadingOverlay = document.querySelector("#reel-loading-overlay");
const reelLoadingProgressFill = document.querySelector("#reel-loading-progress-fill");
const reelLoadingPercent = document.querySelector("#reel-loading-percent");
const reelLoadingEta = document.querySelector("#reel-loading-eta");

const heroNextEventText = document.querySelector("#hero-next-event-text");
const heroNotificationsText = document.querySelector("#hero-notifications-text");
const heroNewHighlightsCount = document.querySelector("#hero-new-highlights-count");
const watchNowBtn = document.querySelector("#watch-now-btn");

const reelVideo = document.querySelector("#reel-video");
const reelEmpty = document.querySelector("#reel-empty");
const reelThumbnails = document.querySelector("#reel-thumbnails");
const reelTitleEl = document.querySelector("#reel-title");

const continueWatchingSection = document.querySelector("#continue-watching");
const continueWatchingThumb = document.querySelector("#continue-watching-thumb");
const continueWatchingTitle = document.querySelector("#continue-watching-title");
const continueWatchingProgressFill = document.querySelector("#continue-watching-progress-fill");
const continueWatchingResumeBtn = document.querySelector("#continue-watching-resume-btn");

const messagesPreviewList = document.querySelector("#messages-preview-list");
const viewAllMessagesBtn = document.querySelector("#view-all-messages-btn");

const upcomingEventsList = document.querySelector("#upcoming-events-list");
const recentActivityList = document.querySelector("#recent-activity-list");

/* ---------- screen switching (reuses existing tab-btn click logic) ---------- */

function switchToScreen(screenId) {
  const targetBtn = document.querySelector(`.tab-btn[data-screen="${screenId}"]`);
  if (targetBtn) {
    targetBtn.click();
  }
}

/* ---------- PROFILE (real DB persistence — Sprint 3) ---------- */

let currentProfile = null;

function resolveUploadUrl(url) {
  if (!url) return null;
  return url.startsWith("http") ? url : `${API_URL}${url}`;
}

async function fetchProfile() {
  if (!currentUser) return null;

  try {
    currentProfile = await apiFetch(`/api/users/${currentUser.id}/profile`);
  } catch (error) {
    console.error("Failed to load profile:", error);
    currentProfile = null;
  }

  return currentProfile;
}

function renderProfileBlock() {
  if (!currentUser || !currentProfile) return;

  const displayName = currentProfile.display_name || currentUser.email.split("@")[0];

  profileName.textContent = displayName;
  profileSchool.textContent = currentProfile.school || "School not set";
  profileTeam.textContent = currentProfile.team || "Team not set";
  profileGradYear.textContent = currentProfile.graduation_year
    ? `Class of ${currentProfile.graduation_year}`
    : "Class of —";

  const photoUrl = resolveUploadUrl(currentProfile.profile_picture_url);
  // The fallback initial and the photo share one DOM node — background-image
  // paints behind text, it doesn't hide it, so the letter must be cleared
  // whenever a real photo is present or it stays visibly overlaid on top.
  profilePicturePlaceholder.textContent = photoUrl ? "" : displayName.charAt(0).toUpperCase();
  profilePicturePlaceholder.style.backgroundImage = photoUrl ? `url(${photoUrl})` : "none";
}

function renderProfilePhotoPreview(url) {
  if (!editProfilePhotoPreview) return;
  const resolved = url && url.startsWith("blob:") ? url : resolveUploadUrl(url);
  editProfilePhotoPreview.style.backgroundImage = resolved ? `url(${resolved})` : "none";
}

function openEditProfileForm() {
  if (!currentProfile) return;

  editProfileNameInput.value = currentProfile.display_name || "";
  editProfileSchoolInput.value = currentProfile.school || "";
  editProfileTeamInput.value = currentProfile.team || "";
  editProfileGradYearInput.value = currentProfile.graduation_year || "";

  if (editProfilePhotoStatus) editProfilePhotoStatus.textContent = "";
  renderProfilePhotoPreview(currentProfile.profile_picture_url);

  editProfileForm.classList.remove("hidden");
}

function closeEditProfileForm() {
  editProfileForm.classList.add("hidden");
}

if (editProfileBtn) {
  editProfileBtn.addEventListener("click", openEditProfileForm);
}

if (cancelProfileBtn) {
  cancelProfileBtn.addEventListener("click", closeEditProfileForm);
}

if (saveProfileBtn) {
  saveProfileBtn.addEventListener("click", async () => {
    try {
      currentProfile = await apiFetch(`/api/users/${currentUser.id}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: editProfileNameInput.value.trim(),
          school: editProfileSchoolInput.value.trim(),
          team: editProfileTeamInput.value.trim(),
          graduation_year: editProfileGradYearInput.value.trim() || null,
        }),
      });

      renderProfileBlock();
      closeEditProfileForm();
    } catch (error) {
      console.error("Failed to save profile:", error);
      showMessage("Could not save profile. Please try again.");
    }
  });
}

/* ---------- PROFILE PHOTO (client-side compress, then real upload) ---------- */

function compressImageFile(file, maxDimension = 800, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();

      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");

        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);

        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
      };

      image.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

async function handleProfilePhotoSelected(file) {
  if (!file || !currentUser) return;

  if (editProfilePhotoStatus) editProfilePhotoStatus.textContent = "Compressing…";

  try {
    const compressedBlob = await compressImageFile(file);
    renderProfilePhotoPreview(URL.createObjectURL(compressedBlob));

    if (editProfilePhotoStatus) editProfilePhotoStatus.textContent = "Uploading…";

    const formData = new FormData();
    formData.append("photo", compressedBlob, "profile.jpg");

    const updated = await apiFetch(`/api/users/${currentUser.id}/photo`, {
      method: "POST",
      body: formData,
    });

    currentProfile = updated;
    renderProfileBlock();
    renderProfilePhotoPreview(updated.profile_picture_url);

    if (editProfilePhotoStatus) editProfilePhotoStatus.textContent = "Photo updated.";
  } catch (error) {
    console.error("Photo upload failed:", error);
    if (editProfilePhotoStatus) editProfilePhotoStatus.textContent = "Could not upload photo.";

    // Beta Stabilization Sprint: the optimistic local-blob preview shown
    // above (before the upload even started) was left showing the failed
    // new photo even though the real Home header correctly kept the old
    // one — revert the edit-modal swatch back to the last-known-good
    // picture so it doesn't display something that was never saved.
    renderProfilePhotoPreview(currentProfile?.profile_picture_url);
  }
}

if (editProfilePhotoUpload) {
  editProfilePhotoUpload.addEventListener("change", (event) => {
    handleProfilePhotoSelected(event.target.files[0]);
  });
}

if (editProfilePhotoCamera) {
  editProfilePhotoCamera.addEventListener("change", (event) => {
    handleProfilePhotoSelected(event.target.files[0]);
  });
}

/* ---------- HERO CARD ---------- */

function renderHeroCard(clips) {
  const nextEvent = MOCK_EVENTS[0];

  heroNextEventText.textContent = nextEvent
    ? `${EVENT_TYPE_LABELS[nextEvent.type]} — ${new Date(nextEvent.startsAt).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : "Nothing scheduled";

  heroNotificationsText.textContent = MOCK_NOTIFICATIONS.coachUnreadCount
    ? `${MOCK_NOTIFICATIONS.coachUnreadCount} new from ${MOCK_NOTIFICATIONS.latestFrom}`
    : "No new notes";

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newHighlightsCount = clips.filter(
    (clip) => new Date(clip.created_at).getTime() >= sevenDaysAgo
  ).length;

  heroNewHighlightsCount.textContent = String(newHighlightsCount);
}

if (watchNowBtn) {
  watchNowBtn.addEventListener("click", () => {
    if (reelState.clips.length) {
      watchClip(reelState.clips[reelState.index]);
    } else {
      switchToScreen("film-screen");
    }
  });
}

/* ---------- FEATURED HIGHLIGHT REEL ---------- */

const reelState = {
  clips: [],
  index: 0,
  timer: null,
  thumbnailCache: new Map(),
};

async function generateClipThumbnail(video, clip) {
  const cacheKey = `${video.id}:${clip.id}`;

  if (reelState.thumbnailCache.has(cacheKey)) {
    return reelState.thumbnailCache.get(cacheKey);
  }

  const videoUrl = video.file_url.startsWith("http")
    ? video.file_url
    : `${API_URL}${video.file_url}`;

  const thumbnail = await new Promise((resolve) => {
    const probeVideo = document.createElement("video");

    probeVideo.crossOrigin = "anonymous";
    probeVideo.muted = true;
    probeVideo.preload = "auto";
    probeVideo.src = videoUrl;

    const fail = () => resolve(null);
    const timeoutId = setTimeout(fail, 6000);

    probeVideo.addEventListener("loadedmetadata", () => {
      probeVideo.currentTime = Math.min(
        Number(clip.start_time) || 0,
        Math.max(0, (probeVideo.duration || 1) - 0.1)
      );
    });

    probeVideo.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(probeVideo, 0, 0, canvas.width, canvas.height);

        clearTimeout(timeoutId);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch (error) {
        // Cross-origin video without CORS headers taints the canvas —
        // expected when the page origin differs from API_URL (e.g. local
        // dev pointed at the deployed backend). Fall back to a placeholder.
        clearTimeout(timeoutId);
        resolve(null);
      }
    });

    probeVideo.addEventListener("error", fail);
  });

  reelState.thumbnailCache.set(cacheKey, thumbnail);
  return thumbnail;
}

// Team Highlights, Slice 1: each clip now carries its own resolved,
// authorized playback info (clip.video, embedded server-side by
// GET /api/users/:id/clips — see clips.js) instead of this function
// separately joining against the Film list (GET /api/videos) by
// video_id. That join broke the moment the Film list started excluding
// film-removed sources: a clip whose source was removed from Film would
// silently vanish from the reel even though the clip and the source's R2
// object were both still completely intact. clip.video is authoritative
// and independent of Film-list membership — no videos parameter needed
// here anymore.
async function loadReelData(clips) {
  const withVideo = clips
    .filter((clip) => clip.video && clip.video.available !== false && clip.video.playback_state === "playable")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  reelState.clips = withVideo;
  reelState.index = 0;

  if (!withVideo.length) {
    reelEmpty.classList.remove("hidden");
    reelVideo.classList.add("hidden");
    reelThumbnails.innerHTML = "";
    stopReelRotation();
    return;
  }

  reelEmpty.classList.add("hidden");
  reelVideo.classList.remove("hidden");

  const thumbnails = await Promise.all(
    withVideo.map((clip) => generateClipThumbnail(clip.video, clip))
  );

  reelThumbnails.innerHTML = "";

  withVideo.forEach((clip, index) => {
    const thumbBtn = document.createElement("button");
    thumbBtn.className = "reel-thumb-btn";
    thumbBtn.type = "button";

    if (thumbnails[index]) {
      thumbBtn.style.backgroundImage = `url(${thumbnails[index]})`;
    } else {
      thumbBtn.classList.add("reel-thumb-fallback");
      thumbBtn.textContent = clip.title.charAt(0).toUpperCase();
    }

    thumbBtn.title = clip.title;
    thumbBtn.addEventListener("click", () => selectReelClip(index));

    reelThumbnails.appendChild(thumbBtn);
  });

  renderFeaturedClip();
  startReelRotation();
}

function renderFeaturedClip() {
  const clip = reelState.clips[reelState.index];
  if (!clip || !clip.video) return;

  const videoUrl = clip.video.file_url.startsWith("http")
    ? clip.video.file_url
    : `${API_URL}${clip.video.file_url}`;

  reelVideo.pause();
  reelVideo.src = `${videoUrl}#t=${clip.start_time}`;
  reelVideo.load();

  if (reelTitleEl) {
    reelTitleEl.textContent = clip.title;
  }

  Array.from(reelThumbnails.children).forEach((child, index) => {
    child.classList.toggle("active", index === reelState.index);
  });
}

function selectReelClip(index) {
  reelState.index = index;
  renderFeaturedClip();
  restartReelTimer();
}

function startReelRotation() {
  stopReelRotation();

  reelState.timer = setInterval(() => {
    reelState.index = (reelState.index + 1) % reelState.clips.length;
    renderFeaturedClip();
  }, 6500);
}

function restartReelTimer() {
  if (!reelState.clips.length) return;
  startReelRotation();
}

function stopReelRotation() {
  if (reelState.timer) {
    clearInterval(reelState.timer);
    reelState.timer = null;
  }
}

// Team Highlights, Slice 1: uses the clip's own embedded, authorized
// clip.video (see loadReelData's comment above) instead of looking the
// video up in allVideos (the Film-list-filtered array) — a highlight
// whose source was removed from Film must still be watchable from here.
function watchClip(clip) {
  if (!clip) return;

  if (clip.video) {
    selectVideo(clip.video);
  }

  switchToScreen("film-screen");

  setTimeout(() => {
    filmPlayer.currentTime = Number(clip.start_time) || 0;
    filmPlayer.play().catch(() => {});
  }, 150);
}

if (reelVideo) {
  reelVideo.addEventListener("click", () => {
    watchClip(reelState.clips[reelState.index]);
  });
}

/* ---------- CONTINUE WATCHING (localStorage only) ---------- */

const CONTINUE_WATCHING_KEY = "cresamor_continue_watching";
let lastProgressSaveAt = 0;

function saveWatchProgressThrottled() {
  const now = Date.now();
  if (now - lastProgressSaveAt < 3000) return;
  lastProgressSaveAt = now;

  if (!currentVideoId || !filmPlayer.duration) return;
  if (filmPlayer.currentTime < 3) return; // don't bother tracking the very start

  const currentVideo = allVideos.find((v) => v.id === currentVideoId);

  const entry = {
    videoId: currentVideoId,
    title: currentVideo ? currentVideo.title : "Untitled film",
    position: filmPlayer.currentTime,
    duration: filmPlayer.duration,
    updatedAt: new Date().toISOString(),
  };

  localStorage.setItem(CONTINUE_WATCHING_KEY, JSON.stringify(entry));
}

function getContinueWatching() {
  try {
    const entry = JSON.parse(localStorage.getItem(CONTINUE_WATCHING_KEY));
    if (!entry || !entry.duration) return null;

    const remaining = entry.duration - entry.position;
    if (remaining < 5) return null; // basically finished, don't show it

    return entry;
  } catch {
    return null;
  }
}

// Playback-fix pass: accepts an optional freshly-fetched videos array.
// renderHome() calls this once early (for instant render, before its own
// video fetch resolves) and again once that fetch completes — the
// availability check only applies once a video list is actually available,
// so the early call can't wrongly hide a valid entry due to `allVideos`
// still being stale/empty from a race with app.js's own loadVideos().
function renderContinueWatching(videos) {
  const entry = getContinueWatching();

  if (!entry) {
    continueWatchingSection.classList.add("hidden");
    return;
  }

  const videoList = Array.isArray(videos) && videos.length ? videos : allVideos;

  if (videoList.length) {
    const matchingVideo = videoList.find((v) => v.id === entry.videoId);

    if (!matchingVideo || matchingVideo.available === false) {
      continueWatchingSection.classList.add("hidden");
      return;
    }
  }

  continueWatchingSection.classList.remove("hidden");
  continueWatchingTitle.textContent = entry.title;

  const percent = Math.min(100, Math.round((entry.position / entry.duration) * 100));
  continueWatchingProgressFill.style.width = `${percent}%`;
}

if (continueWatchingResumeBtn) {
  continueWatchingResumeBtn.addEventListener("click", () => {
    const entry = getContinueWatching();
    if (!entry) return;

    const video = allVideos.find((v) => v.id === entry.videoId);
    if (video) {
      selectVideo(video);
    }

    switchToScreen("film-screen");

    setTimeout(() => {
      filmPlayer.currentTime = entry.position;
      filmPlayer.play().catch(() => {});
    }, 150);
  });
}

/* ---------- MESSAGES PREVIEW (reads the existing fake #message-thread) ---------- */

let messagesPreviewUnread = MOCK_NOTIFICATIONS.coachUnreadCount;

function categorizeMessageRow(row) {
  const username = row.querySelector(".message-username")?.textContent || "";
  const isCoach = row.classList.contains("coach-message");

  if (isCoach) return "coach";
  if (/parent/i.test(username)) return "parent";
  return "athlete";
}

const MESSAGE_CATEGORY_ORDER = ["coach", "parent", "team", "athlete"];
const MESSAGE_CATEGORY_LABELS = {
  coach: "Coach",
  parent: "Parent",
  team: "Team Chat",
  athlete: "Athlete",
};

function renderMessagesPreview() {
  const thread = document.querySelector("#message-thread");
  if (!thread || !messagesPreviewList) return;

  const rows = Array.from(thread.querySelectorAll(".message-row"));

  const byCategory = rows.reduce((acc, row) => {
    const category = categorizeMessageRow(row);
    acc[category] = row; // keep the last (most recent) row per category
    return acc;
  }, {});

  messagesPreviewList.innerHTML = "";

  const orderedEntries = MESSAGE_CATEGORY_ORDER.filter((category) => byCategory[category]);

  if (!orderedEntries.length) {
    messagesPreviewList.innerHTML = "<li class='empty-state'>No messages yet.</li>";
    return;
  }

  orderedEntries.forEach((category, index) => {
    const row = byCategory[category];
    const sender = row.querySelector(".message-username")?.textContent || "Unknown";
    const preview = row.querySelector(".message-bubble")?.textContent || "";

    const li = document.createElement("li");
    li.className = "message-preview-item";

    li.innerHTML = `
      <div class="message-preview-avatar">${sender.charAt(0).toUpperCase()}</div>
      <div class="message-preview-body">
        <div class="message-preview-top">
          <span class="message-preview-sender">${sender}</span>
          <span class="message-preview-category">${MESSAGE_CATEGORY_LABELS[category]}</span>
        </div>
        <p class="message-preview-text">${preview}</p>
      </div>
      ${index === 0 && messagesPreviewUnread ? `<span class="unread-badge">${messagesPreviewUnread}</span>` : ""}
    `;

    messagesPreviewList.appendChild(li);
  });
}

if (viewAllMessagesBtn) {
  viewAllMessagesBtn.addEventListener("click", () => {
    messagesPreviewUnread = 0; // local-only "read" state, resets on reload
    switchToScreen("messages-screen");

    // Foundation Sprint Phase 2: also mark it read server-side now that
    // conversation_participants.last_read_at is real — messages.js exposes
    // this the same way home.js exposes window.renderMessagesPreview.
    if (typeof window.markCurrentConversationRead === "function") {
      window.markCurrentConversationRead();
    }
  });
}

/* ---------- UPCOMING EVENTS (Phase 3: real data) ----------
   Backed by GET /api/users/:id/upcoming-events -- the purpose-built,
   owner-protected endpoint that already does the global-next-3-across-
   all-teams sort/filter/limit server-side (see testSchedule.js #25-31).
   This file does not re-derive any of that: it renders whatever comes
   back (0-3 rows), in the order given. Rows are built with
   createElement/textContent, not innerHTML, since title/location/team
   name are real user-entered strings now, not hardcoded mock text. */

function formatEventTypeLabel(type) {
  return (
    String(type || "")
      .split("_")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || "Event"
  );
}

function renderUpcomingEventRow(event) {
  const li = document.createElement("li");
  li.className = "upcoming-event-item";

  const badge = document.createElement("span");
  badge.className = "event-type-badge";
  badge.textContent = formatEventTypeLabel(event.event_type);

  const details = document.createElement("div");
  details.className = "event-details";

  const titleEl = document.createElement("strong");
  titleEl.textContent = event.title;

  const when = new Date(event.starts_at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const metaEl = document.createElement("small");
  metaEl.textContent = [when, event.team_name, event.location].filter(Boolean).join(" • ");

  details.appendChild(titleEl);
  details.appendChild(metaEl);
  li.appendChild(badge);
  li.appendChild(details);

  li.addEventListener("click", () => {
    // schedule.js loads after home.js (script order), so this only
    // exists once the app has fully loaded -- exactly like
    // window.markCurrentConversationRead's own guarded lookup above.
    if (typeof window.goToScheduleEvent === "function") {
      window.goToScheduleEvent(event);
    } else {
      switchToScreen("schedule-screen");
    }
  });

  return li;
}

async function renderUpcomingEvents() {
  if (!upcomingEventsList || !currentUser) return;

  upcomingEventsList.innerHTML = "";
  const loadingLi = document.createElement("li");
  loadingLi.className = "empty-state";
  loadingLi.textContent = "Loading…";
  upcomingEventsList.appendChild(loadingLi);

  let events;
  try {
    events = await apiFetch(`/api/users/${currentUser.id}/upcoming-events`);
  } catch (error) {
    console.error("Failed to load upcoming events:", error);
    upcomingEventsList.innerHTML = "";
    const errorLi = document.createElement("li");
    errorLi.className = "empty-state";
    errorLi.textContent = "Could not load upcoming events.";
    upcomingEventsList.appendChild(errorLi);
    return;
  }

  upcomingEventsList.innerHTML = "";

  if (!Array.isArray(events) || !events.length) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "empty-state";
    emptyLi.textContent = "No upcoming events.";
    upcomingEventsList.appendChild(emptyLi);
    return;
  }

  events.forEach((event) => upcomingEventsList.appendChild(renderUpcomingEventRow(event)));
}

/* ---------- RECENT ACTIVITY (real data, padded with mock fallback) ---------- */

function renderRecentActivity(videos, clips) {
  if (!recentActivityList) return;

  const realEntries = [
    ...videos.map((video) => ({
      id: `video-${video.id}`,
      type: "film_shared",
      text: `New film uploaded: "${video.title}"`,
      timestamp: video.created_at,
    })),
    ...clips.map((clip) => ({
      id: `clip-${clip.id}`,
      type: "new_highlight",
      text: `New highlight saved: "${clip.title}"`,
      timestamp: clip.created_at,
    })),
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const entries = realEntries.length >= 3
    ? realEntries.slice(0, 8)
    : [...realEntries, ...MOCK_ACTIVITY_FALLBACK].slice(0, 8);

  recentActivityList.innerHTML = "";

  if (!entries.length) {
    recentActivityList.innerHTML = "<li class='empty-state'>No activity yet.</li>";
    return;
  }

  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "activity-item";

    const isMock = entry.id.startsWith("mock-");

    li.innerHTML = `
      <span class="activity-dot activity-${entry.type}"></span>
      <span class="activity-text">${entry.text}${isMock ? ' <em class="mock-tag">(sample)</em>' : ""}</span>
      <span class="activity-time">${new Date(entry.timestamp).toLocaleDateString()}</span>
    `;

    recentActivityList.appendChild(li);
  });
}

/* ---------- MAIN ENTRY ---------- */

async function renderHome() {
  if (!currentUser) return;

  await fetchProfile();
  renderProfileBlock();
  renderUpcomingEvents();
  renderMessagesPreview();
  renderContinueWatching();

  try {
    const [videos, clips] = await Promise.all([
      apiFetch("/api/videos"),
      apiFetch(`/api/users/${currentUser.id}/clips`),
    ]);

    const safeVideos = Array.isArray(videos) ? videos : [];
    const safeClips = Array.isArray(clips) ? clips : [];

    renderHeroCard(safeClips);
    await loadReelData(safeClips);
    renderRecentActivity(safeVideos, safeClips);
    renderContinueWatching(safeVideos);
  } catch (error) {
    console.error("Failed to load Home data:", error);
  }
}

/* ---------- VIDEO LOADING OVERLAYS (real buffering feedback, Sprint 3) ---------- */
/* #video-loading-overlay markup already existed in index.html but nothing
   wired it to real events (dead markup, confirmed during Sprint 3 audit).
   #reel-loading-overlay is new — closes the gap where a slow/cross-origin
   reel video showed a bare spinner with no fallback (found during Sprint 1
   testing). Both driven by the same small helper below, attached as plain
   listeners on the existing video elements — doesn't touch selectVideo()
   or renderFeaturedClip(). */

function estimateEta(video, startedAt) {
  if (!video.duration || !video.buffered.length) return "";

  const bufferedEnd = video.buffered.end(video.buffered.length - 1);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  if (elapsedSeconds < 1 || bufferedEnd <= 0) return "";

  const downloadRate = bufferedEnd / elapsedSeconds; // seconds of video per real second
  if (downloadRate <= 0) return "";

  const remainingSeconds = Math.max(0, video.duration - bufferedEnd);
  const etaSeconds = Math.round(remainingSeconds / downloadRate);

  if (etaSeconds <= 0) return "";
  if (etaSeconds < 60) return `Estimated time remaining: ${etaSeconds}s`;
  return `Estimated time remaining: ${Math.round(etaSeconds / 60)}m`;
}

function wireVideoLoadingOverlay(video, overlay, progressFill, percentEl, etaEl) {
  if (!video || !overlay) return;

  let startedAt = Date.now();

  const show = () => {
    startedAt = Date.now();
    overlay.classList.remove("hidden");
    progressFill.style.width = "0%";
    percentEl.textContent = "0%";
    etaEl.textContent = "";
  };

  const hide = () => overlay.classList.add("hidden");

  const updateProgress = () => {
    if (!video.duration || !video.buffered.length) return;

    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
    const percent = Math.min(100, Math.round((bufferedEnd / video.duration) * 100));

    progressFill.style.width = `${percent}%`;
    percentEl.textContent = `${percent}%`;
    etaEl.textContent = estimateEta(video, startedAt);
  };

  video.addEventListener("loadstart", show);
  video.addEventListener("progress", updateProgress);
  video.addEventListener("waiting", show);
  video.addEventListener("canplay", hide);
  video.addEventListener("canplaythrough", hide);
  video.addEventListener("playing", hide);
  video.addEventListener("error", hide);
}

wireVideoLoadingOverlay(
  filmPlayer,
  videoLoadingOverlay,
  videoLoadingProgressFill,
  videoLoadingPercent,
  videoLoadingEta
);

wireVideoLoadingOverlay(
  reelVideo,
  reelLoadingOverlay,
  reelLoadingProgressFill,
  reelLoadingPercent,
  reelLoadingEta
);

/* ---------- PARENT ACCOUNT (Sprint 3) ---------- */
/* New button in index.html; reuses the existing global handleAuth() from
   app.js exactly like the Coach/Athlete buttons do — no app.js edit needed. */

const loginParentBtn = document.querySelector("#login-parent-btn");

if (loginParentBtn) {
  loginParentBtn.addEventListener("click", () => {
    handleAuth("parent");
  });
}

/* ---------- hook into existing app.js lifecycle without editing it ---------- */

const __originalActivateApp = window.activateApp;
window.activateApp = function (user) {
  __originalActivateApp(user);
  renderHome();
};

// Playback-fix pass, renamed for Team Highlights Slice 1: app.js's
// deleteVideo() (really a "Remove from Film" action now, not a physical
// delete) calls this afterward so Continue Watching drops a
// no-longer-in-Film video without a full page reload — same re-render
// renderHome() already does on login, just triggered on demand. Personal
// highlights are NOT expected to disappear here; loadReelData/clip.video
// (see above) is what keeps them working regardless of Film-list
// membership — this rename exists so the name itself no longer implies
// "the video was destroyed."
window.refreshHomeAfterFilmRemoval = function () {
  if (!currentUser) return;
  renderHome();
};

const __originalLogoutLocalState = window.logoutLocalState;
window.logoutLocalState = function () {
  stopReelRotation();
  __originalLogoutLocalState();
};

filmPlayer.addEventListener("timeupdate", saveWatchProgressThrottled);
filmPlayer.addEventListener("pause", saveWatchProgressThrottled);

// Covers the case where a session was already restored by app.js's own
// restoreSession() call before this script finished loading.
if (currentUser) {
  renderHome();
}
