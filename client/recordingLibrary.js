/*
  recordingLibrary.js — the Recording Library: the single source of truth
  for every video this device has captured, whether or not it has synced
  to the team yet. See ARCHITECTURE.md's "Recording pipeline" section for
  the full ownership model this implements — short version:

    - Every recording (from capture.js today, and from any future source —
      external cameras, imports, AI-generated clips) is created here and
      lives here. Nothing else stores recording data independently.
    - recordingPipeline.js is one consumer of this library, not a peer
      store — it never touches IndexedDB directly, only the functions
      below.
    - The server ("Team Library") is a synchronized view layered on top,
      not the source of truth for this device's own copy.
    - Consumers observe changes via recordingLibrary.subscribe(); nothing
      polls, and nothing mutates state without going through the functions
      below — including transient state like live upload progress.

  IndexedDB is used because it's the only browser storage API that can
  hold Blobs directly (localStorage is string-only and far too small for
  video) — this is the first use of IndexedDB in this project.

  Loaded before recordingPipeline.js and capture.js, both of which depend
  on the global `recordingLibrary` object this file defines.
*/

const RECORDING_DB_NAME = "cresamor_recordings";
const RECORDING_DB_VERSION = 1;
const RECORDING_STORE = "local_recordings";

const recordingLibraryEvents = new EventTarget();

let recordingDbPromise = null;

function openRecordingDb() {
  if (recordingDbPromise) return recordingDbPromise;

  recordingDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDING_DB_NAME, RECORDING_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDING_STORE)) {
        db.createObjectStore(RECORDING_STORE, { keyPath: "recordingId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return recordingDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getRecordingStore(mode) {
  const db = await openRecordingDb();
  return db.transaction(RECORDING_STORE, mode).objectStore(RECORDING_STORE);
}

function generateRecordingId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emitRecordingChange(record) {
  recordingLibraryEvents.dispatchEvent(
    new CustomEvent("change", {
      detail: { recordingId: record.recordingId, lifecycle: record.lifecycle, record },
    })
  );
}

async function putRecordingAndEmit(record) {
  const store = await getRecordingStore("readwrite");
  await idbRequest(store.put(record));
  emitRecordingChange(record);
  return record;
}

function recordingLibrarySubscribe(callback) {
  const handler = (event) => callback(event.detail);
  recordingLibraryEvents.addEventListener("change", handler);
  return () => recordingLibraryEvents.removeEventListener("change", handler);
}

async function recordingLibraryCreate({ blob, title, teamId, uploadedBy, mimeType }) {
  if (!(blob instanceof Blob)) {
    throw new Error("recordingLibrary.create() requires a real Blob/File — got " + typeof blob);
  }

  const record = {
    recordingId: generateRecordingId(),
    blob,
    title,
    teamId: teamId || null,
    uploadedBy,
    mimeType: mimeType || (blob && blob.type) || null,
    createdAt: Date.now(),
    lifecycle: "local",
    queued: true,
    uploadProgress: 0,
    serverVideoId: null,
    needsConversion: false,
    retryCount: 0,
    lastError: null,
  };

  return putRecordingAndEmit(record);
}

async function recordingLibraryGetAll() {
  const store = await getRecordingStore("readonly");
  const all = await idbRequest(store.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

async function recordingLibraryGet(recordingId) {
  const store = await getRecordingStore("readonly");
  return idbRequest(store.get(recordingId));
}

async function recordingLibraryGetPendingUpload() {
  const store = await getRecordingStore("readonly");
  const all = await idbRequest(store.getAll());
  return all
    .filter((record) => record.lifecycle === "local" && record.queued)
    .sort((a, b) => {
      // Production bug fix: a recording that has already failed at least
      // once (e.g. a stalled upload timing out) must not permanently sit
      // at the front of a pure createdAt-FIFO queue and block every
      // never-yet-attempted recording behind it. Untried recordings
      // (retryCount 0) go first as a group; within each group, oldest
      // first as before.
      const aRetried = (a.retryCount || 0) > 0;
      const bRetried = (b.retryCount || 0) > 0;
      if (aRetried !== bRetried) return aRetried ? 1 : -1;
      return a.createdAt - b.createdAt;
    });
}

async function recordingLibraryMarkUploading(recordingId) {
  const record = await recordingLibraryGet(recordingId);
  if (!record) return null;

  record.lifecycle = "uploading";
  record.queued = true;
  return putRecordingAndEmit(record);
}

async function recordingLibraryUpdateProgress(recordingId, percent) {
  const record = await recordingLibraryGet(recordingId);
  if (!record) return null;

  record.uploadProgress = percent;
  return putRecordingAndEmit(record);
}

async function recordingLibraryMarkSynced(recordingId, { serverVideoId, needsConversion }) {
  const record = await recordingLibraryGet(recordingId);
  if (!record) return null;

  record.lifecycle = "synced";
  record.queued = false;
  record.serverVideoId = serverVideoId;
  record.needsConversion = Boolean(needsConversion);
  record.uploadProgress = 100;
  return putRecordingAndEmit(record);
}

async function recordingLibraryMarkProcessed(recordingId) {
  const record = await recordingLibraryGet(recordingId);
  if (!record) return null;

  record.lifecycle = "processed";
  return putRecordingAndEmit(record);
}

async function recordingLibraryMarkFailed(recordingId, error) {
  const record = await recordingLibraryGet(recordingId);
  if (!record) return null;

  record.lifecycle = "local";
  record.queued = true;
  record.retryCount = (record.retryCount || 0) + 1;
  record.lastError = error ? String(error.message || error) : "Upload failed";
  return putRecordingAndEmit(record);
}

async function recordingLibraryRemove(recordingId) {
  const record = await recordingLibraryGet(recordingId);
  const store = await getRecordingStore("readwrite");
  await idbRequest(store.delete(recordingId));

  if (record) {
    emitRecordingChange({ ...record, lifecycle: "removed" });
  }

  return true;
}

const recordingLibrary = {
  create: recordingLibraryCreate,
  getAll: recordingLibraryGetAll,
  get: recordingLibraryGet,
  getPendingUpload: recordingLibraryGetPendingUpload,
  markUploading: recordingLibraryMarkUploading,
  updateProgress: recordingLibraryUpdateProgress,
  markSynced: recordingLibraryMarkSynced,
  markProcessed: recordingLibraryMarkProcessed,
  markFailed: recordingLibraryMarkFailed,
  remove: recordingLibraryRemove,
  subscribe: recordingLibrarySubscribe,
};
