const express = require("express");
const cors = require("cors");
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

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
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
