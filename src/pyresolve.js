// src/pyresolve.js — find a working Python interpreter once and reuse it.
//
// On Windows, `python`/`python3` are often Store execution aliases that can misbehave
// when the app is launched detached from a desktop shortcut (no console). This tries a
// list of candidates, keeps the first that actually responds to `--version`, and logs
// the choice so a "conversion silently does nothing" problem is diagnosable from logs/.

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { makeLogger } = require("./logger");

const log = makeLogger("python");
let _cmd = null; // resolved: { file, prefixArgs }

function candidates() {
  const list = [
    { file: "python", args: [] },
    { file: "python3", args: [] },
    { file: "py", args: ["-3"] },
  ];
  // real Store-package interpreter (bypasses the sometimes-flaky WindowsApps alias)
  try {
    const base = "C:\\Program Files\\WindowsApps";
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (/^PythonSoftwareFoundation\.Python\.3\./i.test(d)) {
          const p = path.join(base, d, "python.exe");
          if (fs.existsSync(p)) list.push({ file: p, args: [] });
        }
      }
    }
  } catch (_) {}
  return list;
}

function works(file, args) {
  try {
    const out = execFileSync(file, [...args, "--version"], { timeout: 8000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return /Python \d/i.test(out.toString());
  } catch (_) {
    return false;
  }
}

// Returns { file, prefixArgs } for spawning python; throws (and logs) if none work.
function resolvePython() {
  if (_cmd) return _cmd;
  for (const c of candidates()) {
    if (works(c.file, c.args)) {
      _cmd = { file: c.file, prefixArgs: c.args };
      log.info(`using Python: ${c.file} ${c.args.join(" ")}`.trim());
      return _cmd;
    }
  }
  log.error("no working Python interpreter found (tried python, python3, py -3, Store package) — PDF/PPT/image conversion needs Python with PyMuPDF/Pillow/NumPy/OpenCV.");
  throw new Error("Python not found — install Python 3 and its packages (see README).");
}

// Convenience: build [file, args] for a python script call.
function pythonCall(scriptAndArgs) {
  const { file, prefixArgs } = resolvePython();
  return { file, args: [...prefixArgs, ...scriptAndArgs] };
}

module.exports = { resolvePython, pythonCall };
