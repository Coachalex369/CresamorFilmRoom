const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");

const app = express();

// Foundation Sprint Phase 5: server/app.js used to hold every route inline
// (grew to 680+ lines across four phases — past this project's own "split
// past ~300-400 lines" guideline). Routes now live in server/routes/,
// grouped by resource. This file is just the composition root: middleware,
// static file serving, and mounting the route modules. Add new resources
// as a new file in server/routes/, not more inline routes here.

const uploadsDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Beta Readiness Sprint 2: CORS is environment-driven rather than a
// hardcoded domain — ALLOWED_ORIGIN lets local dev (localhost:3000) and
// any future staging domain override this with a one-line env var
// instead of a code change, while production stays safe with zero
// required config (falls back to the deployed Render origin).
const DEFAULT_ALLOWED_ORIGIN = "https://cresamorfilmroom-3.onrender.com";
const allowedOrigin = process.env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;

// Production bug fixes, both the same class of mistake: Helmet's default
// CSP directives don't cover every resource type this app actually loads.
//
// media-src (Beta Readiness Sprint 2 follow-up): not set by Helmet's
// defaults, so it fell back to default-src 'self' — which does NOT match
// blob: URLs. That silently broke every local recording preview and Film
// Room playback of an unsynced recording (both play from a blob: URL
// created off the IndexedDB Blob). Confirmed via direct reproduction: a
// <video src="blob:..."> load in production failed with
// "MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check" before
// this fix.
//
// img-src (Beta Stabilization Sprint): Helmet's default is 'self' data:
// — no https:. Profile pictures are served from R2 (a cross-origin https:
// URL), so every profile-picture upload appeared to silently do nothing —
// the upload, DB update, and client re-render were all already correct;
// the browser was just refusing to paint the image. Widened to match this
// same config's existing font-src precedent ('self' https: data:), not a
// new scoping strategy.
//
// media-src / R2 video domain (Production Validation Sprint Round 4
// follow-up): the same class of bug as the blob: fix above, missed because
// it only shows up for a server-backed video, never a local recording.
// Every server-backed video (direct-playable OR remuxed — classification
// doesn't matter) plays from a signed R2 https:// URL, not blob:, so it hit
// this exact same silent CSP block. Confirmed via the browser's own Network
// panel: zero requests were ever issued to the R2 domain when a confirmed-
// playable, confirmed-CORS-correct video was selected — proof the block is
// client-side (CSP), before any network/CORS behavior is even reached. The
// R2 CORS bucket policy fixed earlier this sprint was a real, separate,
// necessary fix — it was just never sufficient on its own, since this CSP
// directive was blocking the request before CORS ever came into play.
// Scoped to Cloudflare R2's endpoint domain (matches any account/bucket
// under it) rather than widening to https: broadly like img-src — video is
// higher-risk content to leave unscoped.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "media-src": ["'self'", "blob:", "https://*.r2.cloudflarestorage.com"],
        "img-src": ["'self'", "data:", "https:"],
      },
    },
  })
);
app.use(cors({ origin: allowedOrigin }));
app.use(morgan("dev"));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "../client")));
app.use("/uploads", express.static(uploadsDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({ message: "Cresamor backend is alive" });
});

app.use(require("./routes/auth"));
app.use(require("./routes/videos"));
app.use(require("./routes/clips"));
app.use(require("./routes/profile"));
app.use(require("./routes/conversations"));
app.use(require("./routes/directMessages"));
app.use(require("./routes/teams"));
app.use(require("./routes/invitations"));
app.use(require("./routes/schedule"));
app.use(require("./routes/teamHighlights"));

// Mobile Recording Upload sprint: real bug found via direct reproduction —
// videos.js/profile.js's multer fileFilter rejects a bad MIME type via
// `cb(new Error(...))`, which multer forwards with next(err). That skips
// the route handler's own try/catch entirely (fileFilter runs as
// middleware BEFORE the handler body), and with no error-handling
// middleware registered, Express's built-in default handler took over —
// a raw HTML "Internal Server Error" page, not JSON. A client parsing the
// response as JSON (or a person just reading the status) got nothing
// useful; confirmed by reproducing a real upload with an
// application/octet-stream video part end to end.
// This also silently covered multer's own file-size-limit rejection
// (MulterError with code LIMIT_FILE_SIZE) — same broken path, never
// exercised in prior testing since fixtures were always small.
// Express recognizes this as error-handling middleware specifically
// because it declares all 4 parameters — must stay last.
app.use((err, req, res, next) => {
  if (err.name === "MulterError" && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File is too large." });
  }

  if (err.message && err.message.startsWith("Unsupported")) {
    return res.status(400).json({ error: err.message });
  }

  // TEMPORARY diagnostic, scoped to this one route (native-recording 500
  // investigation): reaching this handler for /api/upload-video means the
  // error occurred in middleware BEFORE the route handler body ever ran
  // (authenticate/uploadLimiter/multer) — the route's own try/catch would
  // have responded with a different message ("Failed to upload video")
  // and never reached here. Logging the error's identity explicitly so
  // it's easy to grep for. Remove once root-caused.
  if (req.path === "/api/upload-video") {
    console.error(
      `[UPLOAD DIAGNOSTIC] pre-route-handler failure: name=${err.name} code=${err.code || "(none)"} message=${err.message}`
    );
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

module.exports = app;
