/*
  schedule.js — Cresamor's single source of truth for team events: month
  Calendar view, Agenda/List view, Add/Edit/Cancel/Delete, "All Teams" vs
  a specific team. Both views render from ONE fetched array
  (scheduleState.events) via ONE shared fetch function
  (fetchScheduleEvents) -- there is no separate Calendar-events copy and
  Agenda-events copy.

  Team selection is LOCAL to this screen, not shared with teams.js or
  messages.js -- same standing decision as Messages: no application-wide
  "current team" context yet. The localStorage preference
  (SCHEDULE_TEAM_STORAGE_KEY) is only ever a UI hint, revalidated against
  the server's live GET /api/users/:id/teams on every load -- it can
  select which ALREADY-authorized team is shown by default, never
  authorize anything itself. All real authorization is server-side
  (server/routes/schedule.js); every control here is UX only.

  Loaded after teams.js/invitations.js (needs currentUser, apiFetch,
  switchToScreen -- all already defined by then).
*/

/* ---------- DOM refs ---------- */

const scheduleTeamLabel = document.querySelector("#schedule-team-label");
const scheduleTeamSelectLabel = document.querySelector("#schedule-team-select-label");
const scheduleTeamSelect = document.querySelector("#schedule-team-select");
const scheduleTeamEmpty = document.querySelector("#schedule-team-empty");

const scheduleViewCalendarBtn = document.querySelector("#schedule-view-calendar-btn");
const scheduleViewAgendaBtn = document.querySelector("#schedule-view-agenda-btn");
const scheduleAddEventBtn = document.querySelector("#schedule-add-event-btn");

const scheduleCalendarView = document.querySelector("#schedule-calendar-view");
const scheduleCalendarHeader = document.querySelector("#schedule-calendar-header");
const scheduleCalendarMonthLabel = document.querySelector("#schedule-calendar-month-label");
const scheduleCalendarPrevBtn = document.querySelector("#schedule-calendar-prev-btn");
const scheduleCalendarNextBtn = document.querySelector("#schedule-calendar-next-btn");
const scheduleCalendarGrid = document.querySelector("#schedule-calendar-grid");

const scheduleAgendaView = document.querySelector("#schedule-agenda-view");
const scheduleAgendaList = document.querySelector("#schedule-agenda-list");
const scheduleAgendaEmpty = document.querySelector("#schedule-agenda-empty");

const scheduleDayModal = document.querySelector("#schedule-day-modal");
const scheduleDayCloseBtn = document.querySelector("#schedule-day-close-btn");
const scheduleDayModalTitle = document.querySelector("#schedule-day-modal-title");
const scheduleDayEventsList = document.querySelector("#schedule-day-events-list");
const scheduleDayEventsEmpty = document.querySelector("#schedule-day-events-empty");
const scheduleDayAddEventBtn = document.querySelector("#schedule-day-add-event-btn");

const scheduleEventModal = document.querySelector("#schedule-event-modal");
const scheduleEventCloseBtn = document.querySelector("#schedule-event-close-btn");
const scheduleEventModalTitle = document.querySelector("#schedule-event-modal-title");
const scheduleEventTeamSelect = document.querySelector("#schedule-event-team-select");
const scheduleEventTypeSelect = document.querySelector("#schedule-event-type-select");
const scheduleEventTitleInput = document.querySelector("#schedule-event-title-input");
const scheduleEventDateInput = document.querySelector("#schedule-event-date-input");
const scheduleEventStartInput = document.querySelector("#schedule-event-start-input");
const scheduleEventEndInput = document.querySelector("#schedule-event-end-input");
const scheduleEventLocationInput = document.querySelector("#schedule-event-location-input");
const scheduleEventDescriptionInput = document.querySelector("#schedule-event-description-input");
const scheduleEventFormError = document.querySelector("#schedule-event-form-error");
const scheduleEventCanceledBadge = document.querySelector("#schedule-event-canceled-badge");
const scheduleEventSaveBtn = document.querySelector("#schedule-event-save-btn");
const scheduleEventCancelEventBtn = document.querySelector("#schedule-event-cancel-event-btn");
const scheduleEventUncancelBtn = document.querySelector("#schedule-event-uncancel-btn");
const scheduleEventDeleteBtn = document.querySelector("#schedule-event-delete-btn");

const SCHEDULE_EVENT_TYPE_LABELS = {
  practice: "Practice",
  competition: "Competition",
  meeting: "Meeting",
  team_event: "Team Event",
  other: "Other",
};

const SCHEDULE_TEAM_STORAGE_KEY = "cresamor_schedule_selected_team";

/* ---------- state ---------- */

const scheduleState = {
  myTeams: [], // [{id, name, sport, role_on_team, ...}] from GET /api/users/:id/teams
  selectedTeamId: null, // "all" | numeric team id
  events: [], // the ONE fetched array both Calendar and Agenda render from
  view: "calendar", // "calendar" | "agenda"
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
};

let scheduleTeamsLoaded = false;
let editingEvent = null; // the event currently open in the Add/Edit modal, or null when adding

function getManageableTeams() {
  return scheduleState.myTeams.filter((t) => t.role_on_team === "coach");
}

/* ---------- team selection ---------- */

function getStoredScheduleTeamPreference() {
  return localStorage.getItem(SCHEDULE_TEAM_STORAGE_KEY);
}

function setSelectedScheduleTeam(value) {
  scheduleState.selectedTeamId = value;
  if (value !== null && value !== undefined) {
    localStorage.setItem(SCHEDULE_TEAM_STORAGE_KEY, String(value));
  } else {
    localStorage.removeItem(SCHEDULE_TEAM_STORAGE_KEY);
  }
}

// Loads the caller's real, currently-active teams and resolves which
// selection is shown. The stored preference is revalidated against this
// LIVE list every time -- a team the user no longer belongs to (or "all"
// with zero remaining teams) is silently discarded in favor of a real
// current state, never trusted as-is. This is the same discipline
// messages.js already established; the one addition here is the "all"
// sentinel, which is always valid as long as the user has at least one team.
async function loadScheduleTeams() {
  if (!currentUser) return;

  try {
    scheduleState.myTeams = (await apiFetch(`/api/users/${currentUser.id}/teams`)) || [];
  } catch (error) {
    console.error("Failed to load teams for Schedule:", error);
    scheduleState.myTeams = [];
  }

  const teams = scheduleState.myTeams;
  const stored = getStoredScheduleTeamPreference();

  if (!teams.length) {
    setSelectedScheduleTeam(null);
  } else if (teams.length === 1) {
    setSelectedScheduleTeam(teams[0].id);
  } else {
    const storedIsAll = stored === "all";
    const storedIsValidTeam = stored && stored !== "all" && teams.some((t) => Number(t.id) === Number(stored));
    if (storedIsAll || storedIsValidTeam) {
      setSelectedScheduleTeam(storedIsAll ? "all" : Number(stored));
    } else {
      setSelectedScheduleTeam("all");
    }
  }

  renderScheduleTeamContext();
}

function scheduleTeamDisplayLabel(team) {
  // "Do not rely on names alone" -- same reasoning/pattern as messages.js.
  return [team.name, team.sport, team.school_name].filter(Boolean).join(" — ");
}

function renderScheduleTeamContext() {
  if (!scheduleTeamLabel) return;

  const teams = scheduleState.myTeams;

  scheduleTeamLabel.classList.add("hidden");
  scheduleTeamSelectLabel.classList.add("hidden");
  scheduleTeamSelect.classList.add("hidden");
  scheduleTeamEmpty.classList.add("hidden");

  if (!teams.length) {
    scheduleTeamEmpty.classList.remove("hidden");
    scheduleAddEventBtn.classList.add("hidden");
    return;
  }

  if (teams.length === 1) {
    scheduleTeamLabel.textContent = scheduleTeamDisplayLabel(teams[0]);
    scheduleTeamLabel.classList.remove("hidden");
  } else {
    scheduleTeamSelectLabel.classList.remove("hidden");
    scheduleTeamSelect.classList.remove("hidden");
    scheduleTeamSelect.innerHTML = "";

    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "All Teams";
    allOption.selected = scheduleState.selectedTeamId === "all";
    scheduleTeamSelect.appendChild(allOption);

    teams.forEach((team) => {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = scheduleTeamDisplayLabel(team);
      option.selected = Number(team.id) === Number(scheduleState.selectedTeamId);
      scheduleTeamSelect.appendChild(option);
    });
  }

  scheduleAddEventBtn.classList.toggle("hidden", getManageableTeams().length === 0);
}

if (scheduleTeamSelect) {
  scheduleTeamSelect.addEventListener("change", async () => {
    const value = scheduleTeamSelect.value;
    setSelectedScheduleTeam(value === "all" ? "all" : Number(value));
    renderScheduleTeamContext();
    await fetchAndRenderCurrentView();
  });
}

/* ---------- fetching (the one shared data path for both views) ---------- */

// Fetches events for the currently selected team ("all" unions every
// active team the user belongs to, client-side, from per-team calls that
// are each independently re-authorized server-side -- never a single
// "give me everything" endpoint) across the given ISO date range, and
// stores them in scheduleState.events. Both renderScheduleCalendar() and
// renderScheduleAgenda() read from that one array afterward -- neither
// view fetches or stores its own separate copy.
async function fetchScheduleEvents(fromIso, toIso) {
  if (!currentUser || !scheduleState.myTeams.length) {
    scheduleState.events = [];
    return;
  }

  const qs = new URLSearchParams();
  if (fromIso) qs.set("from", fromIso);
  if (toIso) qs.set("to", toIso);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  try {
    if (scheduleState.selectedTeamId === "all") {
      const perTeam = await Promise.all(
        scheduleState.myTeams.map((team) =>
          apiFetch(`/api/teams/${team.id}/events${suffix}`).catch((error) => {
            console.error(`Failed to load schedule for team ${team.id}:`, error);
            return [];
          })
        )
      );
      scheduleState.events = perTeam.flat().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    } else if (scheduleState.selectedTeamId) {
      scheduleState.events = await apiFetch(`/api/teams/${scheduleState.selectedTeamId}/events${suffix}`);
    } else {
      scheduleState.events = [];
    }
  } catch (error) {
    console.error("Failed to load schedule events:", error);
    scheduleState.events = [];
  }
}

async function fetchAndRenderCurrentView() {
  if (scheduleState.view === "calendar") {
    await fetchAndRenderCalendar();
  } else {
    await fetchAndRenderAgenda();
  }
}

/* ---------- Calendar view ---------- */

// Buckets an ISO instant by the browser's LOCAL calendar date, never the
// raw UTC date string -- this is what keeps an event's Calendar-day
// placement matching what the user actually sees as "today"/"this date"
// rather than silently shifting near a timezone's midnight boundary.
function localDateKey(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfCalendarGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - firstOfMonth.getDay());
  return gridStart;
}

async function fetchAndRenderCalendar() {
  const gridStart = startOfCalendarGrid(scheduleState.calendarYear, scheduleState.calendarMonth);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + 42); // 6 full weeks, always covers the month plus lead/trail days

  await fetchScheduleEvents(gridStart.toISOString(), gridEnd.toISOString());
  renderScheduleCalendar();
}

function renderScheduleCalendar() {
  if (!scheduleCalendarGrid) return;

  const { calendarYear, calendarMonth } = scheduleState;
  scheduleCalendarMonthLabel.textContent = new Date(calendarYear, calendarMonth, 1).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });

  const eventsByDay = {};
  scheduleState.events.forEach((event) => {
    const key = localDateKey(event.starts_at);
    if (!eventsByDay[key]) eventsByDay[key] = [];
    eventsByDay[key].push(event);
  });

  const today = new Date();
  const todayKey = localDateKey(today.toISOString());
  const gridStart = startOfCalendarGrid(calendarYear, calendarMonth);

  scheduleCalendarGrid.innerHTML = "";

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(cellDate.getDate() + i);
    const key = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, "0")}-${String(cellDate.getDate()).padStart(2, "0")}`;
    const isOutsideMonth = cellDate.getMonth() !== calendarMonth;
    const dayEvents = eventsByDay[key] || [];

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "schedule-calendar-day";
    if (isOutsideMonth) cell.classList.add("schedule-day-outside-month");
    if (key === todayKey) cell.classList.add("schedule-day-today");

    const numberEl = document.createElement("span");
    numberEl.className = "schedule-calendar-day-number";
    numberEl.textContent = cellDate.getDate();
    cell.appendChild(numberEl);

    if (dayEvents.length) {
      const dotRow = document.createElement("span");
      dotRow.className = "schedule-calendar-day-dot-row";
      dayEvents.slice(0, 6).forEach((event) => {
        const dot = document.createElement("span");
        dot.className = "schedule-calendar-day-dot";
        if (event.status === "canceled") dot.classList.add("schedule-day-dot-canceled");
        dotRow.appendChild(dot);
      });
      cell.appendChild(dotRow);
    }

    cell.addEventListener("click", () => openScheduleDayModal(cellDate, dayEvents));
    scheduleCalendarGrid.appendChild(cell);
  }
}

scheduleCalendarPrevBtn?.addEventListener("click", async () => {
  scheduleState.calendarMonth -= 1;
  if (scheduleState.calendarMonth < 0) {
    scheduleState.calendarMonth = 11;
    scheduleState.calendarYear -= 1;
  }
  await fetchAndRenderCalendar();
});

scheduleCalendarNextBtn?.addEventListener("click", async () => {
  scheduleState.calendarMonth += 1;
  if (scheduleState.calendarMonth > 11) {
    scheduleState.calendarMonth = 0;
    scheduleState.calendarYear += 1;
  }
  await fetchAndRenderCalendar();
});

/* ---------- day detail modal (tap a Calendar day) ---------- */

function eventTimeLabel(event) {
  return new Date(event.starts_at).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderEventRow(event, { forDayModal = false } = {}) {
  const li = document.createElement("li");
  li.className = "schedule-agenda-item";
  if (event.status === "canceled") li.classList.add("schedule-event-canceled");

  const details = document.createElement("div");
  details.className = "schedule-agenda-item-details";

  const titleEl = document.createElement("strong");
  titleEl.textContent = event.title;

  const metaParts = [
    forDayModal ? eventTimeLabel(event) : new Date(event.starts_at).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    SCHEDULE_EVENT_TYPE_LABELS[event.event_type] || event.event_type,
    event.team_name,
    event.location,
  ].filter(Boolean);

  const metaEl = document.createElement("small");
  metaEl.textContent = metaParts.join(" • ") + (event.status === "canceled" ? " • Canceled" : "");

  details.appendChild(titleEl);
  details.appendChild(metaEl);
  li.appendChild(details);

  li.addEventListener("click", () => openScheduleEventModal(event));
  return li;
}

function openScheduleDayModal(date, dayEvents) {
  scheduleDayModalTitle.textContent = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  scheduleDayEventsList.innerHTML = "";
  scheduleDayEventsEmpty.classList.toggle("hidden", dayEvents.length > 0);
  dayEvents
    .slice()
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    .forEach((event) => scheduleDayEventsList.appendChild(renderEventRow(event, { forDayModal: true })));

  const canAddHere = getManageableTeams().length > 0;
  scheduleDayAddEventBtn.classList.toggle("hidden", !canAddHere);
  scheduleDayAddEventBtn.onclick = canAddHere
    ? () => {
        closeScheduleDayModal();
        openScheduleEventModal(null, { defaultDate: date });
      }
    : null;

  scheduleDayModal.classList.remove("hidden");
}

function closeScheduleDayModal() {
  scheduleDayModal.classList.add("hidden");
}

scheduleDayCloseBtn?.addEventListener("click", closeScheduleDayModal);

/* ---------- Agenda view ---------- */

async function fetchAndRenderAgenda() {
  // Forward-looking rolling window, not the team's entire history -- an
  // Agenda is "what's coming up," not an archive. 60 days is a
  // deliberately simple default or the exact number of days ahead;
  // revisit if a real coach needs to plan further out than that.
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

  await fetchScheduleEvents(from, to);
  renderScheduleAgenda();
}

function renderScheduleAgenda() {
  if (!scheduleAgendaList) return;

  scheduleAgendaList.innerHTML = "";
  const sorted = scheduleState.events.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  scheduleAgendaEmpty.classList.toggle("hidden", sorted.length > 0);
  sorted.forEach((event) => scheduleAgendaList.appendChild(renderEventRow(event)));
}

/* ---------- view toggle ---------- */

async function setScheduleView(view) {
  scheduleState.view = view;
  scheduleViewCalendarBtn.classList.toggle("active", view === "calendar");
  scheduleViewAgendaBtn.classList.toggle("active", view === "agenda");
  scheduleCalendarView.classList.toggle("hidden", view !== "calendar");
  scheduleAgendaView.classList.toggle("hidden", view !== "agenda");
  await fetchAndRenderCurrentView();
}

scheduleViewCalendarBtn?.addEventListener("click", () => setScheduleView("calendar"));
scheduleViewAgendaBtn?.addEventListener("click", () => setScheduleView("agenda"));
scheduleAddEventBtn?.addEventListener("click", () => openScheduleEventModal(null));

/* ---------- Add/Edit Event modal ---------- */

// <input type="date"> gives "YYYY-MM-DD", <input type="time"> gives
// "HH:MM". The Date constructor's numeric-args form (year, monthIndex,
// day, hour, minute) is ALWAYS interpreted as browser-LOCAL time,
// unambiguously and consistently across browsers -- unlike parsing a
// raw "YYYY-MM-DDTHH:MM" string, which is exactly the kind of thing that
// can silently shift a Coach's entered time by their UTC offset. This is
// the one function responsible for the "client -> server conversion is
// intentional" requirement.
function buildIsoFromLocalDateAndTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

// The reverse, for prefilling the form on edit -- also LOCAL getters
// (getFullYear/getMonth/getDate/getHours/getMinutes), matching how every
// other date display already works in this app (e.g. home.js's
// toLocaleString calls). This is the "server -> client display is
// intentional" half of the same contract.
function splitIsoToLocalDateAndTime(isoString) {
  if (!isoString) return { date: "", time: "" };
  const d = new Date(isoString);
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

function populateScheduleEventTeamSelect(preferredTeamId) {
  const manageable = getManageableTeams();
  scheduleEventTeamSelect.innerHTML = "";
  manageable.forEach((team) => {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = scheduleTeamDisplayLabel(team);
    option.selected = Number(team.id) === Number(preferredTeamId);
    scheduleEventTeamSelect.appendChild(option);
  });
}

// event: null = Add mode. A real event object = Edit/View mode -- which
// one depends on whether the CALLER manages that event's team (never
// trusted client-side beyond hiding controls; the server independently
// re-authorizes every write against the event's own team_id regardless
// of what this modal shows).
function openScheduleEventModal(event, { defaultDate, defaultTeamId } = {}) {
  editingEvent = event;
  scheduleEventFormError.classList.add("hidden");

  const manageable = getManageableTeams();
  const canManageThisEvent = event ? manageable.some((t) => Number(t.id) === Number(event.team_id)) : manageable.length > 0;

  scheduleEventModalTitle.textContent = event ? (canManageThisEvent ? "Edit Event" : "Event Details") : "Add Event";

  const preferredTeamId =
    event?.team_id ??
    defaultTeamId ??
    (scheduleState.selectedTeamId !== "all" ? scheduleState.selectedTeamId : manageable[0]?.id);
  populateScheduleEventTeamSelect(preferredTeamId);

  scheduleEventTypeSelect.value = event?.event_type || "practice";
  scheduleEventTitleInput.value = event?.title || "";
  scheduleEventLocationInput.value = event?.location || "";
  scheduleEventDescriptionInput.value = event?.description || "";

  if (event) {
    const start = splitIsoToLocalDateAndTime(event.starts_at);
    const end = splitIsoToLocalDateAndTime(event.ends_at);
    scheduleEventDateInput.value = start.date;
    scheduleEventStartInput.value = start.time;
    scheduleEventEndInput.value = end.time;
  } else {
    const d = defaultDate || new Date();
    scheduleEventDateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    scheduleEventStartInput.value = "";
    scheduleEventEndInput.value = "";
  }

  scheduleEventCanceledBadge.classList.toggle("hidden", event?.status !== "canceled");

  const formDisabled = event && !canManageThisEvent;
  [
    scheduleEventTeamSelect,
    scheduleEventTypeSelect,
    scheduleEventTitleInput,
    scheduleEventDateInput,
    scheduleEventStartInput,
    scheduleEventEndInput,
    scheduleEventLocationInput,
    scheduleEventDescriptionInput,
  ].forEach((el) => {
    el.disabled = Boolean(formDisabled);
  });

  scheduleEventSaveBtn.classList.toggle("hidden", Boolean(formDisabled));
  scheduleEventCancelEventBtn.classList.toggle("hidden", formDisabled || !event || event.status === "canceled");
  scheduleEventUncancelBtn.classList.toggle("hidden", formDisabled || !event || event.status !== "canceled");
  scheduleEventDeleteBtn.classList.toggle("hidden", formDisabled || !event);

  scheduleEventModal.classList.remove("hidden");
}

function closeScheduleEventModal() {
  scheduleEventModal.classList.add("hidden");
  editingEvent = null;
}

scheduleEventCloseBtn?.addEventListener("click", closeScheduleEventModal);

scheduleEventSaveBtn?.addEventListener("click", async () => {
  scheduleEventFormError.classList.add("hidden");

  const teamId = scheduleEventTeamSelect.value;
  const eventType = scheduleEventTypeSelect.value;
  const title = scheduleEventTitleInput.value.trim();
  const startsAt = buildIsoFromLocalDateAndTime(scheduleEventDateInput.value, scheduleEventStartInput.value);
  const endsAt = scheduleEventEndInput.value
    ? buildIsoFromLocalDateAndTime(scheduleEventDateInput.value, scheduleEventEndInput.value)
    : null;

  if (!teamId) {
    scheduleEventFormError.textContent = "Choose a team you manage.";
    scheduleEventFormError.classList.remove("hidden");
    return;
  }
  if (!title) {
    scheduleEventFormError.textContent = "Title is required.";
    scheduleEventFormError.classList.remove("hidden");
    return;
  }
  if (!startsAt) {
    scheduleEventFormError.textContent = "Date and start time are required.";
    scheduleEventFormError.classList.remove("hidden");
    return;
  }

  const body = {
    event_type: eventType,
    title,
    description: scheduleEventDescriptionInput.value.trim() || null,
    location: scheduleEventLocationInput.value.trim() || null,
    starts_at: startsAt,
    ends_at: endsAt,
  };

  try {
    if (editingEvent) {
      await apiFetch(`/api/events/${editingEvent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      await apiFetch(`/api/teams/${teamId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    closeScheduleEventModal();
    closeScheduleDayModal();
    await fetchAndRenderCurrentView();
  } catch (error) {
    console.error("Failed to save event:", error);
    scheduleEventFormError.textContent = error.message || "Could not save this event. Please try again.";
    scheduleEventFormError.classList.remove("hidden");
  }
});

// Cancel preserves the record (status='canceled') -- "this legitimately
// happened/was scheduled but is no longer happening," visible history,
// reversible via Restore. A single confirm(), matching this app's
// existing confirmation pattern (teams.js's revokeMember).
scheduleEventCancelEventBtn?.addEventListener("click", async () => {
  if (!editingEvent) return;
  if (!confirm(`Cancel "${editingEvent.title}"? It will stay visible on the schedule marked as canceled.`)) return;

  try {
    await apiFetch(`/api/events/${editingEvent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "canceled" }),
    });
    closeScheduleEventModal();
    await fetchAndRenderCurrentView();
  } catch (error) {
    console.error("Failed to cancel event:", error);
    showMessage(error.message || "Could not cancel this event.");
  }
});

scheduleEventUncancelBtn?.addEventListener("click", async () => {
  if (!editingEvent) return;

  try {
    await apiFetch(`/api/events/${editingEvent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "scheduled" }),
    });
    closeScheduleEventModal();
    await fetchAndRenderCurrentView();
  } catch (error) {
    console.error("Failed to restore event:", error);
    showMessage(error.message || "Could not restore this event.");
  }
});

// Delete is genuinely destructive (hard removal, no history left behind)
// -- deliberately a stronger confirmation message than Cancel's, per the
// "Delete should be treated as more destructive than Cancel" requirement.
scheduleEventDeleteBtn?.addEventListener("click", async () => {
  if (!editingEvent) return;
  if (
    !confirm(
      `Permanently delete "${editingEvent.title}"? This cannot be undone. If this event legitimately happened but was called off, use Cancel Event instead.`
    )
  ) {
    return;
  }

  try {
    await apiFetch(`/api/events/${editingEvent.id}`, { method: "DELETE" });
    closeScheduleEventModal();
    await fetchAndRenderCurrentView();
  } catch (error) {
    console.error("Failed to delete event:", error);
    showMessage(error.message || "Could not delete this event.");
  }
});

/* ---------- entry point / lifecycle ---------- */

async function initScheduleScreen() {
  if (!currentUser) return;

  if (!scheduleTeamsLoaded) {
    await loadScheduleTeams();
    scheduleTeamsLoaded = true;
  } else {
    // Re-validate on every screen entry, not just the first -- team
    // membership can change (revocation) while the app stays open.
    await loadScheduleTeams();
  }

  await fetchAndRenderCurrentView();
}

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.screen === "schedule-screen") {
      initScheduleScreen();
    }
  });
});

// Home's "next three" rows call this instead of a generic
// switchToScreen("schedule-screen") so the click actually lands on the
// event's own month/day rather than whatever month Schedule happened to
// be showing last. Re-runs initScheduleScreen() itself (idempotent, same
// as the tab-click listener above) rather than assuming the screen is
// already initialized -- Home can reach this before Schedule has ever
// been opened this session. Forces "All Teams" for a multi-team user so
// the event is guaranteed visible regardless of whatever single-team
// filter they last had selected -- their stored preference itself is
// left untouched, this only changes the current view.
window.goToScheduleEvent = async function (event) {
  if (!event || !currentUser) return;

  switchToScreen("schedule-screen");
  await initScheduleScreen();

  if (scheduleState.myTeams.length > 1 && scheduleState.selectedTeamId !== "all") {
    scheduleState.selectedTeamId = "all";
    renderScheduleTeamContext();
  }

  const eventDate = new Date(event.starts_at);
  scheduleState.calendarYear = eventDate.getFullYear();
  scheduleState.calendarMonth = eventDate.getMonth();
  scheduleState.view = "calendar";
  scheduleViewCalendarBtn?.classList.add("active");
  scheduleViewAgendaBtn?.classList.remove("active");
  scheduleCalendarView?.classList.remove("hidden");
  scheduleAgendaView?.classList.add("hidden");

  await fetchAndRenderCalendar();

  const dayKey = localDateKey(event.starts_at);
  const dayEvents = scheduleState.events.filter((e) => localDateKey(e.starts_at) === dayKey);
  openScheduleDayModal(eventDate, dayEvents);
};

const __originalActivateAppForSchedule = window.activateApp;
window.activateApp = function (user) {
  __originalActivateAppForSchedule(user);
  scheduleTeamsLoaded = false;
  scheduleState.myTeams = [];
  scheduleState.selectedTeamId = null;
  scheduleState.events = [];
};

const __originalLogoutLocalStateForSchedule = window.logoutLocalState;
window.logoutLocalState = function () {
  scheduleTeamsLoaded = false;
  scheduleState.myTeams = [];
  scheduleState.selectedTeamId = null;
  scheduleState.events = [];
  __originalLogoutLocalStateForSchedule();
};

if (currentUser) {
  initScheduleScreen();
}
