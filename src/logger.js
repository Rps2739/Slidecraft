// src/logger.js — lightweight file logger (no deps). Everything the app does that's
// worth tracing after the fact goes to logs/, so a bug can be diagnosed from the log
// folder alone instead of whatever happened to still be in the terminal.
//
//   logs/app-YYYY-MM-DD.log      — every INFO/WARN/ERROR/DEBUG line, one file per day
//   logs/error-YYYY-MM-DD.log    — just WARN/ERROR, for fast bug triage
//   logs/conversions/<jobId>.json — full report for one conversion run (inputs, options,
//                                   per-slide results, timing) — the main artifact for
//                                   "what happened on this specific conversion"
//
// Logging must never be able to crash the app, so every write is best-effort.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const CONV_DIR = path.join(LOG_DIR, "conversions");
const RETENTION_DAYS = 14;

try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch (_) {}

const today = () => new Date().toISOString().slice(0, 10);

function appendSafe(file, line) {
  try { fs.appendFileSync(file, line); } catch (_) { /* logging must never throw */ }
}

function stringify(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "object" && a !== null) {
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }
  return String(a);
}

function write(level, scope, args) {
  const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] [${scope}] ${args.map(stringify).join(" ")}\n`;
  appendSafe(path.join(LOG_DIR, `app-${today()}.log`), line);
  if (level === "WARN" || level === "ERROR") appendSafe(path.join(LOG_DIR, `error-${today()}.log`), line);
}

// prune log files older than RETENTION_DAYS so logs/ doesn't grow forever
function cleanup() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const dir of [LOG_DIR, CONV_DIR]) {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
      }
    }
  } catch (_) {}
}
cleanup();

// One logger per module ("scope"), so log lines say where they came from, e.g. [build].
function makeLogger(scope) {
  return {
    debug: (...a) => write("DEBUG", scope, a), // file only — verbose, not printed to console
    info: (...a) => write("INFO", scope, a),
    warn: (...a) => { write("WARN", scope, a); console.warn(`[${scope}]`, ...a); },
    error: (...a) => { write("ERROR", scope, a); console.error(`[${scope}]`, ...a); },
  };
}

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveJobReport(jobId, data) {
  try {
    fs.writeFileSync(path.join(CONV_DIR, `${jobId}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    write("ERROR", "logger", [`failed to save job report ${jobId}:`, e.message]);
  }
}

module.exports = { makeLogger, saveJobReport, newJobId, LOG_DIR, CONV_DIR };
