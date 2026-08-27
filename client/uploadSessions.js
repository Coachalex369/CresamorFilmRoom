/*
  uploadSessions.js — durable IndexedDB bookkeeping for resumable, direct-
  to-R2 multipart video uploads (see server/routes/videoUploads.js and
  migration 019_video_uploads.sql). Same IndexedDB pattern as
  recordingLibrary.js (separate database, separate concern): this tracks
  upload-SESSION progress only — completed part numbers/ETags and the
  {name, size, type, lastModified} fingerprint of the File the session was
  started for — not the video content itself. No Blob is ever stored here.

  This is NOT the Recording Library. recordingLibrary.js owns *recordings*
  captured through capture.js (the video content, local-first, IndexedDB
  Blob storage) — a completely separate concern from this file, which only
  serves the manual-picker resumable-upload path (multipartUploader.js).

  The server is still the authority on what has actually landed (R2's own
  ListParts, surfaced via GET /api/video-uploads/:sessionId) — the
  completedParts cache here exists for progress UI and as the same-file-
  reselection matcher on resume, not as something trusted on its own to
  decide what's safe to skip re-uploading. See multipartUploader.js's
  reconcile step, which always overwrites this cache from the server's
  answer before uploading anything.

  Loaded after recordingLibrary.js/app.js, before multipartUploader.js —
  its only consumer.
*/

const UPLOAD_SESSION_DB_NAME = "cresamor_upload_sessions";
const UPLOAD_SESSION_DB_VERSION = 1;
const UPLOAD_SESSION_STORE = "upload_sessions";

let uploadSessionDbPromise = null;

function openUploadSessionDb() {
  if (uploadSessionDbPromise) return uploadSessionDbPromise;

  uploadSessionDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(UPLOAD_SESSION_DB_NAME, UPLOAD_SESSION_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UPLOAD_SESSION_STORE)) {
        db.createObjectStore(UPLOAD_SESSION_STORE, { keyPath: "uploadId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return uploadSessionDbPromise;
}

// Named distinctly from recordingLibrary.js's own identical-shaped
// idbRequest() helper rather than reusing it — see CLAUDE.md's top-level
// collision warning; two files sharing one global scope must not lean on
// each other's private helpers just because the shapes happen to match.
function uploadSessionIdbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getUploadSessionStore(mode) {
  const db = await openUploadSessionDb();
  return db.transaction(UPLOAD_SESSION_STORE, mode).objectStore(UPLOAD_SESSION_STORE);
}

async function putUploadSession(session) {
  const store = await getUploadSessionStore("readwrite");
  await uploadSessionIdbRequest(store.put(session));
  return session;
}

// The fingerprint a session is resumed against. lastModified is the field
// that actually distinguishes "the same file, re-selected" from "a
// different file that happens to share a name/size" — mirrors the
// server's own video_uploads.last_modified column (see migration 019's
// header for why: a mobile browser can't retain a File handle across an
// app restart, so the user re-selects the file by hand, and the fingerprint
// is the only way to tell whether the reselected file is genuinely the one
// the in-progress session belongs to).
function fingerprintOf(file) {
  return {
    name: file.name,
    size: file.size,
    type: file.type || "",
    lastModified: file.lastModified ?? null,
  };
}

function fingerprintMatches(session, file) {
  const fp = fingerprintOf(file);
  return (
    session.fileName === fp.name &&
    Number(session.fileSize) === fp.size &&
    (session.fileType || "") === fp.type &&
    Number(session.lastModified ?? null) === Number(fp.lastModified)
  );
}

async function uploadSessionsCreate({ uploadId, storageKey, teamId, title, file, partSize, partCount }) {
  const fp = fingerprintOf(file);

  const session = {
    uploadId,
    storageKey,
    teamId: teamId || null,
    title,
    fileName: fp.name,
    fileSize: fp.size,
    fileType: fp.type,
    lastModified: fp.lastModified,
    partSize,
    partCount,
    completedParts: [], // [{ partNumber, etag }] — local cache only, see file header
    status: "in_progress",
    videoId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return putUploadSession(session);
}

async function uploadSessionsGet(uploadId) {
  const store = await getUploadSessionStore("readonly");
  return uploadSessionIdbRequest(store.get(uploadId));
}

async function uploadSessionsGetAll() {
  const store = await getUploadSessionStore("readonly");
  return uploadSessionIdbRequest(store.getAll());
}

// The resume entry point: finds a still-in_progress local session whose
// fingerprint matches the File the user just re-selected. Returns null on
// no match — including when a same-named file exists locally but its
// size/type/lastModified differ, which means it's a genuinely different
// file and must NOT resume against someone else's part progress (the
// exact hazard this check exists to prevent).
async function uploadSessionsFindResumable(file) {
  const all = await uploadSessionsGetAll();
  return all.find((session) => session.status === "in_progress" && fingerprintMatches(session, file)) || null;
}

async function uploadSessionsRecordPart(uploadId, partNumber, etag) {
  const session = await uploadSessionsGet(uploadId);
  if (!session) return null;

  const withoutThisPart = session.completedParts.filter((p) => p.partNumber !== partNumber);
  session.completedParts = [...withoutThisPart, { partNumber, etag }];
  session.updatedAt = Date.now();
  return putUploadSession(session);
}

// Overwrites the local completedParts cache with the server's authoritative
// list (from GET /api/video-uploads/:sessionId, itself backed by R2's own
// ListParts) — called once on resume, before any new part upload, so a
// stale/partial local cache never causes a real completed part to be
// skipped from the final /complete call, or a genuinely missing one to be
// wrongly assumed present.
async function uploadSessionsReconcile(uploadId, completedParts) {
  const session = await uploadSessionsGet(uploadId);
  if (!session) return null;

  session.completedParts = completedParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
  session.updatedAt = Date.now();
  return putUploadSession(session);
}

async function uploadSessionsSetStatus(uploadId, status, extra = {}) {
  const session = await uploadSessionsGet(uploadId);
  if (!session) return null;

  session.status = status;
  session.updatedAt = Date.now();
  Object.assign(session, extra);
  return putUploadSession(session);
}

async function uploadSessionsRemove(uploadId) {
  const store = await getUploadSessionStore("readwrite");
  await uploadSessionIdbRequest(store.delete(uploadId));
  return true;
}

const uploadSessions = {
  create: uploadSessionsCreate,
  get: uploadSessionsGet,
  getAll: uploadSessionsGetAll,
  findResumable: uploadSessionsFindResumable,
  recordPart: uploadSessionsRecordPart,
  reconcile: uploadSessionsReconcile,
  setStatus: uploadSessionsSetStatus,
  remove: uploadSessionsRemove,
};
