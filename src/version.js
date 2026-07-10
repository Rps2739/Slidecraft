// src/version.js — a signature of the code that gets loaded INTO the long-running
// server process, so the launcher can tell when a running server is stale.
//
// A Node process reads its require()d files once at startup and never re-reads them,
// so editing build.js / src/*.js has NO effect until the process restarts. This hash
// lets scripts/launch.js compare the running server's code against what's on disk and
// restart automatically when they differ — no more "I edited it but the app still runs
// the old code" surprises.
//
// UI/static files (served fresh on each request) and spawned helpers (.py/.ps1, run as
// separate processes each time) are NOT baked into the process, so they don't count here.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");

function sourceFiles() {
  const files = [path.join(ROOT, "build.js")];
  const srcDir = path.join(ROOT, "src");
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith(".js")) files.push(path.join(srcDir, f));
    }
  } catch (_) {}
  return files.sort();
}

// Short content hash of all in-process source. Same hash on disk vs. in a running
// server => up to date; different => the server is running stale code.
function sourceSignature() {
  const h = crypto.createHash("sha1");
  for (const f of sourceFiles()) {
    try { h.update(path.basename(f)); h.update(fs.readFileSync(f)); } catch (_) {}
  }
  return h.digest("hex").slice(0, 12);
}

module.exports = { sourceSignature };
