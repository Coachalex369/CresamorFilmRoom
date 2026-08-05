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

module.exports = { upload, getSignedUrl, exists, remove, downloadToFile, getObjectSize };
