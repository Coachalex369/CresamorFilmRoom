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

// Production bug fix (Beta Readiness Sprint 2 follow-up): Helmet's default
// CSP doesn't set media-src, so it falls back to default-src 'self' —
// which does NOT match blob: URLs. That silently broke every local
// recording preview and Film Room playback of an unsynced recording
// (both play from a blob: URL created off the IndexedDB Blob). Confirmed
// via direct reproduction: a <video src="blob:..."> load in production
// failed with "MEDIA_ELEMENT_ERROR: Media load rejected by URL safety
// check" before this fix. Everything else about Helmet's defaults is
// still appropriate (see the original Sprint 2 plan) — this adds the one
// directive this app's blob-URL-based local playback actually needs.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "media-src": ["'self'", "blob:"],
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
app.use(require("./routes/teams"));

module.exports = app;
