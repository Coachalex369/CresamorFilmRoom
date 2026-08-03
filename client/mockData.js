/*
  mockData.js — TEMPORARY placeholder data only.
  Every export here is fake, isolated to this file so it's trivial to find
  and delete once real backend endpoints exist (teams/events/messages/activity).
  Nothing in this file is persisted anywhere — it's constants used to fill
  UI sections that don't have a real data source yet.
*/

const MOCK_EVENTS = [
  {
    id: "mock-evt-1",
    type: "practice",
    title: "Wrestling Practice",
    startsAt: (() => {
      const d = new Date();
      d.setHours(16, 0, 0, 0);
      return d.toISOString();
    })(),
    location: "Main Gym",
  },
  {
    id: "mock-evt-2",
    type: "game",
    title: "Dual Meet vs. Central",
    startsAt: (() => {
      const d = new Date();
      d.setDate(d.getDate() + 3);
      d.setHours(18, 30, 0, 0);
      return d.toISOString();
    })(),
    location: "Away — Central High",
  },
  {
    id: "mock-evt-3",
    type: "weight_cert",
    title: "Weight Certification",
    startsAt: (() => {
      const d = new Date();
      d.setDate(d.getDate() + 6);
      d.setHours(7, 0, 0, 0);
      return d.toISOString();
    })(),
    location: "Athletic Office",
  },
];

const MOCK_NOTIFICATIONS = {
  coachUnreadCount: 2,
  latestFrom: "Coach Ramirez",
  latestPreview: "Great pressure in the second period.",
};

const MOCK_ACTIVITY_FALLBACK = [
  {
    id: "mock-act-1",
    type: "coach_comment",
    text: "Coach Ramirez commented on your latest clip.",
    timestamp: (() => {
      const d = new Date();
      d.setHours(d.getHours() - 5);
      return d.toISOString();
    })(),
  },
  {
    id: "mock-act-2",
    type: "film_shared",
    text: "New team film was shared with you.",
    timestamp: (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString();
    })(),
  },
];

const EVENT_TYPE_LABELS = {
  practice: "Practice",
  game: "Game",
  meeting: "Meeting",
  weight_cert: "Weight Certification",
};

// Recording flow's "Choose Team" list — no teams table exists yet, so this
// is a fixed local list until a real Teams backend phase lands.
const MOCK_TEAMS = [
  { id: "team-wrestling", name: "Cresamor Wrestling", sport: "wrestling" },
  { id: "team-football", name: "Cresamor Football", sport: "football" },
  { id: "team-jv-wrestling", name: "JV Wrestling", sport: "wrestling" },
];
