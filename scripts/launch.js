// scripts/launch.js — smart launcher for the desktop shortcut.
// If the server is already running, just opens ONE browser tab to it.
// Otherwise starts it detached (survives after this script exits), waits until it
// answers, then opens the browser itself — exactly once. The server is told NOT to
// open a browser (SLIDECRAFT_LAUNCHED=1) so we never get a double / duplicate window.

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 4599;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");

function isRunning(cb) {
  const req = http.get(URL, (res) => { res.resume(); cb(true); });
  req.on("error", () => cb(false));
  req.setTimeout(1200, () => { req.destroy(); cb(false); });
}

// Open the default browser to URL WITHOUT flashing a console window and without
// spawning one window per Chrome profile. rundll32's FileProtocolHandler routes the
// URL through the shell's default-browser association and reuses an already-open
// browser window (adds a tab) rather than launching fresh profile windows the way
// `cmd start` / `explorer <url>` can.
function openBrowser() {
  try {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", URL],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (_) {}
}

// Poll until the freshly-spawned server answers, then open the browser once.
function openWhenReady(triesLeft) {
  isRunning((running) => {
    if (running) return openBrowser();
    if (triesLeft <= 0) return openBrowser(); // give up waiting; try anyway
    setTimeout(() => openWhenReady(triesLeft - 1), 400);
  });
}

isRunning((running) => {
  if (running) {
    openBrowser();
    return;
  }
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, SLIDECRAFT_LAUNCHED: "1" }, // server won't self-open the browser
  });
  child.unref();
  openWhenReady(25); // up to ~10s for the server to come up
});
