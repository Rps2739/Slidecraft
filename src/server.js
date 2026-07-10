// src/server.js — local, offline web UI for the converter.
//
// Binds to 127.0.0.1 only (loopback; never exposed to the network). Serves the
// static UI and a small JSON API that runs the same convert() pipeline and returns
// the per-slide report, source thumbnails, and a downloadable deck.pptx.

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { convert } = require("../build");
const { makeLogger, newJobId, LOG_DIR } = require("./logger");
const { sourceSignature } = require("./version");

const log = makeLogger("server");
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "output");
const IN_DIR = path.join(ROOT, ".ui-input");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Signature of the code THIS process loaded at startup. The launcher compares it to
// the code on disk and restarts the server when they differ (see scripts/launch.js),
// so an edit always reaches the user instead of a days-old process serving stale code.
const BUILD_SIG = sourceSignature();

// Catch anything that slips past the request handlers' own try/catch — log it instead
// of letting the process crash (or die silently) with no trace. The server keeps running:
// this is a local single-user tool, and losing the whole app over one bad request is
// worse than logging and carrying on.
process.on("uncaughtException", (e) => log.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e));

function startServer(port = parseInt(process.env.PORT, 10) || 4599) {
  const app = express();
  app.use(express.json({ limit: "200mb" })); // base64 PPTX/PDF uploads can be large
  app.use(express.static(path.join(ROOT, "ui")));

  // Streams progress as Server-Sent Events so the UI can show a real (determinate)
  // progress bar + ETA. Each line is `data: {json}\n\n`; the final event is the full
  // result (type:"done") or an error (type:"error").
  app.post("/api/convert", async (req, res) => {
    const id = newJobId();
    const t0 = Date.now();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.flushHeaders) res.flushHeaders();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
    try {
      const { files = [], fast = false, autoFix = true, overlayOnly = false } = req.body;
      if (!files.length) {
        log.warn(`request ${id}: rejected — no files provided`);
        send({ type: "error", error: "no files provided" });
        return res.end();
      }
      log.info(`request ${id}: ${files.length} file(s)`, { names: files.map((f) => f.name), fast, autoFix, overlayOnly });

      // write uploaded slide files into a fresh input dir, preserving order via prefix
      fs.rmSync(IN_DIR, { recursive: true, force: true });
      fs.mkdirSync(IN_DIR, { recursive: true });
      const inputs = files.map((f, i) => {
        const safe = String(f.name || `slide-${i}`).replace(/[^\w.\- ]+/g, "_");
        const p = path.join(IN_DIR, `${String(i).padStart(3, "0")}-${safe}`);
        const m = /^data:[^;]*;base64,(.*)$/s.exec(f.content || "");
        if (m) fs.writeFileSync(p, Buffer.from(m[1], "base64")); // PDF/image (binary)
        else fs.writeFileSync(p, f.content, "utf8"); // html/txt
        return p;
      });

      const outFile = path.join(OUT_DIR, `deck-${id}.pptx`);
      const workDir = path.join(ROOT, ".work");
      // PowerPoint verification needs Windows + Office; elsewhere (Docker/Linux hosts)
      // fall back to quick mode automatically instead of failing the conversion.
      const canVerify = os.platform() === "win32";
      const result = await convert(inputs, {
        out: outFile, fast: fast || !canVerify, workDir, autoFix, overlayOnly, jobId: id,
        onProgress: (evt) => send({ type: "progress", ...evt }),
      });

      // attach source thumbnails (base64) in slide order
      const srcDir = path.join(workDir, "src");
      const thumbs = result.reports.map((_, i) => {
        const p = path.join(srcDir, `slide-${String(i + 1).padStart(2, "0")}.png`);
        return fs.existsSync(p) ? "data:image/png;base64," + fs.readFileSync(p).toString("base64") : null;
      });

      log.info(`request ${id} ok in ${Date.now() - t0}ms:`, { slides: result.count, autoFixed: result.autoFixed || 0 });
      send({
        type: "done",
        ok: true,
        count: result.count,
        reports: result.reports,
        thumbnails: thumbs,
        autoFixed: result.autoFixed || 0,
        download: `/download/${path.basename(outFile)}`,
      });
      res.end();
    } catch (e) {
      log.error(`request ${id} failed after ${Date.now() - t0}ms:`, e);
      send({ type: "error", error: String(e.message || e) });
      res.end();
    }
  });

  // Build signature — the launcher polls this to detect a stale (old-code) server.
  app.get("/api/version", (_req, res) => res.json({ sig: BUILD_SIG }));

  // What this deployment can do. PowerPoint-backed features (visual verification, PPTX
  // input, PDF export) need Windows + Office, so a Linux/cloud host advertises them off
  // and the UI adapts (hides the PDF button, shows a "cloud mode" note, etc.).
  const WIN = os.platform() === "win32";
  app.get("/api/capabilities", (_req, res) => res.json({
    platform: os.platform(),
    powerpoint: WIN,
    features: { verify: WIN, pptxInput: WIN, pdfExport: WIN },
  }));

  // Graceful shutdown so the launcher can restart a stale server with fresh code.
  // Loopback-only: refuse remote callers even if the server is bound to 0.0.0.0.
  app.post("/api/shutdown", (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) {
      return res.status(403).json({ error: "shutdown allowed from localhost only" });
    }
    log.info("shutdown requested by launcher (restart for fresh code)");
    res.json({ ok: true });
    // let the response flush, then exit so the port frees for the new process
    setTimeout(() => process.exit(0), 150);
  });

  app.get("/download/:file", (req, res) => {
    const p = path.join(OUT_DIR, path.basename(req.params.file));
    if (!fs.existsSync(p)) return res.status(404).end();
    res.download(p, "deck.pptx");
  });

  // live per-slide preview during a conversion: each slide's source render is written to
  // .work/src/slide-NN.png as it completes; the UI polls this as progress events arrive.
  app.get("/work-thumb/:n", (req, res) => {
    const n = parseInt(req.params.n, 10);
    if (!Number.isInteger(n) || n < 1 || n > 999) return res.status(400).end();
    const p = path.join(ROOT, ".work", "src", `slide-${String(n).padStart(2, "0")}.png`);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store");
    // NOT res.sendFile: ".work" is a dotfolder and sendFile denies dotfile paths by default
    res.type("png").send(fs.readFileSync(p));
  });

  // convert the generated pptx to PDF on demand (via PowerPoint) and send it
  app.get("/download-pdf/:file", (req, res) => {
    if (!WIN) return res.status(501).json({ error: "PDF export needs PowerPoint (Windows only); unavailable on this host." });
    const pptx = path.join(OUT_DIR, path.basename(req.params.file));
    if (!fs.existsSync(pptx)) return res.status(404).end();
    const pdf = pptx.replace(/\.pptx$/i, ".pdf");
    const { execFile } = require("child_process");
    const script = path.join(ROOT, "scripts", "pptx_to_pdf.ps1");
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Pptx", pptx, "-Pdf", pdf],
      { windowsHide: true },
      (err) => {
        if (err || !fs.existsSync(pdf)) {
          log.error("PDF conversion failed for", pptx, err);
          return res.status(500).json({ error: "PDF conversion failed: " + (err && err.message) });
        }
        res.download(pdf, "deck.pdf");
      });
  });

  // Bind loopback by default (local-first, never exposed). Cloud/Docker deploys set
  // HOST=0.0.0.0 and PORT via env (Render/Railway/Fly inject PORT automatically).
  const host = process.env.HOST || "127.0.0.1";
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
      console.log(`\n  HTML->PPTX converter UI running at:  ${url}\n  Press Ctrl+C to stop.\n`);
      log.info(`server started on ${host}:${port} (cwd ${process.cwd()}, build ${BUILD_SIG})`);
      // health check: log whether the external tools conversions depend on are reachable
      // from THIS process's environment. Launched-from-shortcut runs have a different PATH
      // than a terminal, so this is where a "conversion does nothing" cause shows up.
      try {
        const { resolvePython } = require("./pyresolve");
        try { resolvePython(); } catch (e) { log.warn("startup health: Python unavailable —", e.message); }
        if (os.platform() === "win32") {
          const { execFileSync } = require("child_process");
          try { execFileSync("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { timeout: 8000, stdio: "ignore", windowsHide: true }); }
          catch (e) { log.warn("startup health: PowerShell unavailable (PDF/PPT export + verification need it) —", e.message); }
        } else {
          log.info("non-Windows host: PowerPoint verification unavailable — conversions run in quick mode");
        }
      } catch (_) {}
      resolve({ server, url });
    });
    server.on("error", (e) => log.error("server failed to start:", e));
  });
}

if (require.main === module) {
  startServer().then(({ url }) => {
    // Auto-open the browser ONLY when started directly (npm start). When the desktop
    // shortcut launches us it sets SLIDECRAFT_LAUNCHED=1 and opens the browser itself
    // (exactly once) — opening here too would pop a second window.
    if (process.env.SLIDECRAFT_LAUNCHED) return;
    // rundll32 FileProtocolHandler: no console flash, reuses an existing browser window.
    const { spawn } = require("child_process");
    if (os.platform() === "win32") {
      try { spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch (_) {}
    }
  });
}

module.exports = { startServer };
