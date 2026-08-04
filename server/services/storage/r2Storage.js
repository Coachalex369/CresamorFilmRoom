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

async function getSignedUrl(key, expiresInSeconds = 3600) {
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

async function remove(key) {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (error) {
    console.error("Failed to delete R2 object:", key, error);
  }
}

module.exports = { upload, getSignedUrl, exists, remove };
