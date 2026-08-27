/*
  r2Storage.js — Cloudflare R2 storage provider. R2 is S3-API-compatible,
  so this uses the standard AWS SDK v3 pointed at R2's endpoint. Active
  when STORAGE_PROVIDER=r2 (see storage.js). Credentials come only from
  process.env — see ARCHITECTURE.md's "Manual Cloudflare setup" for what
  to create and where to set them (Render's dashboard in production, a
  local .env for testing against the real bucket).

  Bucket is private — no public access. Playback goes through
  getSignedUrl(), a short-lived signed GET URL, never a permanent
  public link.
*/

const fs = require("fs");
const { pipeline } = require("stream/promises");
const {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl: presign } = require("@aws-sdk/s3-request-presigner");

const BUCKET = process.env.R2_BUCKET_NAME;

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Streams the temp file straight to R2 via a multipart upload — never
// buffers the whole file in Node's memory, which matters on Render's
// constrained instance for anything approaching a full game recording.
async function upload(key, filePath, contentType) {
  const body = fs.createReadStream(filePath);

  const uploader = new Upload({
    client,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: contentType },
  });

  await uploader.done();
  await fs.promises.unlink(filePath);
}

// 20 minutes, not the more typical 1 hour — a deliberately short window
// (per explicit request) even though it means a coach reviewing a game
// film longer than this, or seeking after the window closes, will hit a
// 403 on the next range request and need to reselect the video to get a
// fresh URL. No mitigation for that mid-playback interruption yet; worth
// revisiting if it turns out to bother real beta testers.
async function getSignedUrl(key, expiresInSeconds = 1200) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return presign(client, command, { expiresIn: expiresInSeconds });
}

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) return false;
    console.error("R2 exists() check failed:", key, error);
    return false;
  }
}

// Startup conversion recovery's fallback for legacy rows that predate
// source_size_bytes (see videoProcessing.js's recoverStrandedConversions())
// — a HEAD request only, never downloads the object. Throws on any
// failure (including not-found) rather than swallowing it like exists()
// does, since the caller needs to distinguish "confirmed size" from
// "couldn't determine" and treat the latter as unsafe to auto-resume.
async function getObjectSize(key) {
  const result = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  return result.ContentLength;
}

async function remove(key) {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (error) {
    console.error("Failed to delete R2 object:", key, error);
  }
}

// Beta Stabilization Sprint (MOV conversion): the first download-oriented
// function this project has needed — everything before this was upload-
// only. Streams straight to disk via pipeline(), never buffers the whole
// object in memory, matching the upload side's existing discipline.
async function downloadToFile(key, destPath) {
  const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await pipeline(response.Body, fs.createWriteStream(destPath));
}

// Resumable direct-to-R2 uploads (server/routes/videoUploads.js). Deliberately
// R2-only — unlike getObjectSize/downloadToFile above (trivial file
// operations with an obvious local-disk equivalent), a real "browser PUTs a
// chunk directly to storage via a short-lived signed URL" has no meaningful
// local-disk analogue without inventing a fake local signing server. The
// route checks STORAGE_PROVIDER === 'r2' itself and returns a clear error
// otherwise, rather than this module or storage.js pretending to be
// symmetric here.

async function createMultipartUpload(key, contentType) {
  const result = await client.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: contentType })
  );
  return result.UploadId;
}

// Minted on demand, one call per part, right before that part is actually
// attempted — never batch-minted up front. A mobile resume can happen hours
// after the session started; a URL stashed at initiate time would already
// be expired by then. Short expiry (default 15 min) is long enough for one
// part's PUT on a poor connection, short enough to be genuinely time-limited
// per the "no permanent/long-lived credentials reach the client" requirement.
async function presignUploadPart(key, r2UploadId, partNumber, expiresInSeconds = 900) {
  const command = new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: r2UploadId,
    PartNumber: partNumber,
  });
  return presign(client, command, { expiresIn: expiresInSeconds });
}

// parts: [{ PartNumber, ETag }]. This call IS the real trust boundary for
// "did the client actually upload what it claims" -- R2 rejects completion
// outright if a part/ETag doesn't match what it actually has, so there's no
// separate pre-check to invent here; the route's job is just to not swallow
// that rejection.
async function completeMultipartUpload(key, r2UploadId, parts) {
  return client.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: r2UploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

// Best-effort, same "missing isn't an error" contract as remove() -- used
// both for an explicit user cancel and the orphan sweep (uploadSweep.js),
// and a session that was already completed/aborted (e.g. a duplicate sweep
// pass) throwing NoSuchUpload here is expected, not a failure to surface.
async function abortMultipartUpload(key, r2UploadId) {
  try {
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: r2UploadId })
    );
  } catch (error) {
    if (error.name !== "NoSuchUpload") {
      console.error("Failed to abort R2 multipart upload:", r2UploadId, error);
    }
  }
}

// The authoritative "what has actually landed" read for resume -- the
// server always asks R2 fresh rather than trusting the client's own
// IndexedDB bookkeeping, which could be stale or partially evicted.
// Paginated defensively even though a realistic part count (a few hundred,
// at a 10MB part size up to several GB) fits in one page.
async function listParts(key, r2UploadId) {
  const parts = [];
  let partNumberMarker;

  do {
    const result = await client.send(
      new ListPartsCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: r2UploadId,
        PartNumberMarker: partNumberMarker,
      })
    );

    for (const part of result.Parts || []) {
      parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size });
    }

    partNumberMarker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (partNumberMarker);

  return parts;
}

module.exports = {
  upload,
  getSignedUrl,
  exists,
  remove,
  downloadToFile,
  getObjectSize,
  createMultipartUpload,
  presignUploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  listParts,
};
