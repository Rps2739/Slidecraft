// scripts/launch.js — smart launcher for the desktop shortcut.
//
// A Node server loads its code once at startup and never re-reads it, so a server that
// has been running for days keeps serving OLD code no matter how many times you edit the
// files or click the shortcut. This launcher fixes that: if a server is already running
// it checks whether that server's code matches what's on disk, and RESTARTS it when they
// differ. Otherwise it just opens a browser tab. Either way the browser is opened exactly
// once, with no console window.

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { sourceSignature } = require(path.join(__dirname, "..", "src", "version"));

const PORT = 4599;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");

function isRunning(cb) {
  const req = http.get(URL, (res) => { res.resume(); cb(true); });
  req.on("error", () => cb(false));
  req.setTimeout(1200, () => { req.destroy(); cb(false); });
}

// Ask the running server for the code signature it started with. cb(null) if the server
// is too old to have the endpoint (which itself means it's stale and should restart).
function runningSig(cb) {
  const req = http.get(`${URL}/api/version`, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => { try { cb(JSON.parse(body).sig || null); } catch (_) { cb(null); } });
  });
  req.on("error", () => cb(null));
  req.setTimeout(1500, () => { req.destroy(); cb(null); });
}

function requestShutdown(cb) {
  const req = http.request(`${URL}/api/shutdown`, { method: "POST" }, (res) => { res.resume(); res.on("end", cb); });
  req.on("error", cb); // if it errored, it's probably already down
  req.setTimeout(2000, () => { req.destroy(); cb(); });
  req.end();
}

// Fallback for servers too old to shut themselves down (no /api/shutdown): find whatever
// process is holding the port and kill it, so a fresh server can bind. Windows-only; a
// no-op elsewhere (graceful shutdown covers those).
function forceFreePort(cb) {
  if (process.platform !== "win32") return cb();
  const { execFile } = require("child_process");
  execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }, (err, out) => {
    if (err || !out) return cb();
    const pids = new Set();
    out.split(/\r?\n/).forEach((line) => {
      if (line.includes(`:${PORT} `) && /LISTENING/i.test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
    });
    if (!pids.size) return cb();
    let n = pids.size;
    pids.forEach((pid) => execFile("taskkill", ["/F", "/PID", pid], { windowsHide: true }, () => { if (--n === 0) cb(); }));
  });
}

// no console flash, reuses an existing browser window (adds a tab) rather than spawning
// one window per Chrome profile the way `cmd start` / `explorer <url>` can.
function openBrowser() {
  try {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", URL],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (_) {}
}

function spawnServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, SLIDECRAFT_LAUNCHED: "1" }, // server won't self-open the browser
  });
  child.unref();
}

// Poll until the freshly-spawned server answers, then open the browser once.
function openWhenReady(triesLeft) {
  isRunning((up) => {
    if (up) return openBrowser();
    if (triesLeft <= 0) return openBrowser(); // give up waiting; try anyway
    setTimeout(() => openWhenReady(triesLeft - 1), 400);
  });
}

// Wait for the port to free after a graceful shutdown, then start a fresh server + open
// browser. If it hasn't freed in time (e.g. an old server that ignored the shutdown), the
// port is force-freed as a last resort.
function restartFresh(triesLeft) {
  isRunning((up) => {
    if (!up) { spawnServer(); return openWhenReady(25); }
    if (triesLeft <= 0) {
      return forceFreePort(() => setTimeout(() => { spawnServer(); openWhenReady(25); }, 400));
    }
    setTimeout(() => restartFresh(triesLeft - 1), 300);
  });
}

isRunning((up) => {
  if (!up) {
    spawnServer();
    openWhenReady(25); // up to ~10s for the server to come up
    return;
  }
  // a server is up — is it running the current code?
  runningSig((sig) => {
    if (sig && sig === sourceSignature()) {
      openBrowser();                                   // up to date: just open a tab
    } else if (sig) {
      requestShutdown(() => restartFresh(20));         // newer server: ask it to exit
    } else {
      // too old to report a version (no /api endpoints) -> force-free + restart
      forceFreePort(() => setTimeout(() => { spawnServer(); openWhenReady(25); }, 500));
    }
  });
});
