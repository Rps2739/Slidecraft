// src/render.js — network-sealed headless renderer.
//
// Loads a single slide's HTML in a local headless Chromium, serving ALL assets
// (Tailwind, Font Awesome, fonts) from the local `assets/` folder and BLOCKING
// every other network request. This is what makes the app fully offline: once
// deps are installed, conversion touches nothing on the internet.
//
// Exposes a RenderSession that can render many slides on one browser instance:
//   const session = await openSession();
//   const page = await session.load(htmlString);   // returns a live puppeteer Page
//   ... use extract(page) / measureText / clip / slidePng ...
//   await session.close();

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");

// CDN URL patterns the reference slides use -> local asset file they map to.
// Everything else off-origin is blocked.
function mapCdnToLocal(url) {
  if (/tailwindcss|tailwind(\.min)?\.css/i.test(url)) return path.join(ASSETS, "tailwind", "tailwind.generated.css");
  if (/fontawesome|font-awesome/i.test(url)) return path.join(ASSETS, "fontawesome", "all.min.css");
  if (/fonts\.googleapis\.com/i.test(url)) return path.join(ASSETS, "fonts", "fonts.css");
  // JS charting libraries (ECharts / Chart.js) — many AI slide generators (Genspark,
  // etc.) draw charts with these; without them the chart <div>s render empty.
  if (/echarts/i.test(url)) return path.join(ASSETS, "charts", "echarts.min.js");
  if (/chart\.?js|chart\.umd|chart\.min\.js/i.test(url)) return path.join(ASSETS, "charts", "chart.min.js");
  return null;
}

const CONTENT_TYPES = {
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Local static server: serves the current slide HTML at "/" and anything under /assets/*.
// Bound to loopback only.
function startServer() {
  const state = { html: "<!DOCTYPE html><html><body></body></html>" };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(state.html);
    }
    if (url.startsWith("/assets/")) {
      const filePath = path.join(ASSETS, url.slice("/assets/".length));
      // prevent path traversal outside ASSETS
      if (!path.resolve(filePath).startsWith(ASSETS)) {
        res.writeHead(403);
        return res.end();
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

async function openSession() {
  const { server, state, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const LAUNCH = {
    headless: "new",
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",   // don't put big buffers in limited /dev/shm — renderer OOM/crash
      "--disable-gpu",
      "--disable-crash-reporter",
    ],
  };
  let browser = await puppeteer.launch(LAUNCH);

  const alive = () => browser &&
    (typeof browser.connected === "boolean" ? browser.connected : (browser.isConnected ? browser.isConnected() : true));

  async function ensureBrowser() {
    if (!alive()) {
      try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
      browser = await puppeteer.launch(LAUNCH);
    }
    return browser;
  }

  // A single dense/overflowing slide can crash the Chromium renderer (usually on the giant
  // screenshot). That must NOT take down the rest of the deck: if the browser dies mid-slide,
  // relaunch it and retry the slide once; a second failure is reported for just that slide
  // (per-slide try/catch in build.js) while every following slide still gets a live browser.
  async function load(html) {
    await ensureBrowser();
    try {
      return await loadOnce(html);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/Target closed|Connection closed|Protocol error|Session closed|detached|disconnected|Target\.|browser has disconnected/i.test(msg)) {
        try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
        browser = await puppeteer.launch(LAUNCH);
        return await loadOnce(html); // one clean retry on a fresh browser
      }
      throw e;
    }
  }

  async function loadOnce(html) {
    state.html = rewriteAssetLinks(html, base);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    const blocked = [];
    page.on("request", (reqObj) => {
      const url = reqObj.url();
      // allow our own loopback origin (the slide + /assets/*)
      if (url.startsWith(base) || url.startsWith("data:")) return reqObj.continue();
      // map known CDN URLs to local assets by redirecting to our own origin
      const local = mapCdnToLocal(url);
      if (local) {
        // translate to a loopback /assets URL so the static server handles it
        const rel = "/assets/" + path.relative(ASSETS, local).replace(/\\/g, "/");
        return reqObj.continue({ url: base + rel });
      }
      // everything else on the internet is blocked
      blocked.push(url);
      return reqObj.abort();
    });
    await page.goto(base + "/", { waitUntil: "networkidle0", timeout: 30000 });
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch (_) {}
    // freeze CSS animations/transitions: an element captured mid-animation (pulse ring,
    // spin, hover transition) would report inflated/rotated geometry and dirty clips.
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
    // Force the SAME font substitution the emitter will apply (systemFont) into the browser
    // BEFORE we measure geometry, so the pixel-diff later reflects real layout drift — not
    // the gap between the browser's web-font fallback and PowerPoint's installed-font
    // substitute. Web-font-heavy AI decks (Inter/Oswald/Roboto Mono, none installed) were
    // drifting 6-8% purely from this mismatch and getting flattened to images. Icon fonts
    // (Font Awesome, Material, etc.) are detected and left untouched so glyphs stay intact.
    await page.evaluate(() => {
      const INSTALLED = new Set(["arial","arial narrow","arial black","calibri","calibri light","cambria","candara","consolas","constantia","corbel","courier new","georgia","impact","lucida console","lucida sans unicode","palatino linotype","segoe ui","segoe ui semibold","segoe ui light","tahoma","times new roman","trebuchet ms","verdana","bahnschrift","comic sans ms","franklin gothic medium","gabriola","sylfaen"]);
      const sys = (fam) => {
        if (!fam) return null;
        const first = fam.split(",")[0].replace(/['"]/g, "").trim();
        if (INSTALLED.has(first.toLowerCase())) return null;           // already installed — keep
        const s = fam.toLowerCase();
        if (/awesome|glyphicon|material icons|feather|bootstrap-icons|ionicon|remixicon|fontello|typicons|octicons|dashicons/.test(s)) return null; // icon font — never touch
        if (/\bmono|consol|courier|menlo|monaco|cascadia|source ?code|fira ?code|jetbrains|ibm plex mono|ubuntu mono/.test(s)) return "Consolas";
        if (/condensed|narrow|oswald|bebas|anton|barlow ?condensed|archivo ?narrow|pathway/.test(s)) return "Arial Narrow";
        if ((/\bserif\b/.test(s) && !/sans/.test(s)) || /times|georgia|garamond|merriweather|playfair|\blora\b|pt ?serif|noto ?serif|source ?serif|cambria|roboto ?slab|spectral|bitter|libre ?baskerville/.test(s)) return "Georgia";
        return "Arial";
      };
      document.querySelectorAll("*").forEach((el) => {
        const m = sys(getComputedStyle(el).fontFamily);
        if (m) el.style.setProperty("font-family", m, "important");
      });
    });
    // size the viewport to the slide's declared canvas, then enlarge it to the natural
    // content extent so overflowing content is measurable & clippable (the overflow-fit
    // step in extract/emit scales it back to fit the slide — nothing gets cut off).
    const size = await page.evaluate(() => {
      const c = document.querySelector(".slide-container") || document.body;
      const r = c.getBoundingClientRect();
      const cw = Math.round(r.width) || 1280, ch = Math.round(r.height) || 720;
      // reveal overflow so scroll extents reflect the true content size
      c.style.overflow = "visible";
      const natW = Math.max(cw, c.scrollWidth || cw);
      const natH = Math.max(ch, c.scrollHeight || ch);
      return { w: cw, h: ch, natW, natH };
    });
    const vpW = Math.min(Math.max(size.w, size.natW), 5000);
    const vpH = Math.min(Math.max(size.h, size.natH), 5000);
    // Cap total DEVICE pixels so the screenshot buffer can't blow up the renderer. At scale 2
    // a tall/overflowing slide (e.g. 2500×5000 CSS px) would be 5000×10000 = 50MP × 4 bytes =
    // ~200MB and reliably crashes Chromium ("Page.captureScreenshot: Target closed"). Drop the
    // scale for big pages; normal 1280×720 slides keep the crisp 2× render.
    let dsf = 2;
    while (vpW * dsf * vpH * dsf > 24e6 && dsf > 1) dsf -= 0.5; // budget ~24MP device (~96MB buffer)
    await page.setViewport({ width: vpW, height: vpH, deviceScaleFactor: dsf });

    // Let JS charts (ECharts / Chart.js) finish drawing. They render into a <canvas>
    // that ECharts sizes to its container, so nudge a resize at the final viewport and
    // give them a moment to settle before extraction reads the canvas.
    try {
      const hasCharts = await page.evaluate(() =>
        !!(window.echarts || window.Chart) || document.querySelector("canvas") != null);
      if (hasCharts) {
        await page.evaluate(() => {
          // resize any live ECharts instances explicitly, then a generic window resize
          try { document.querySelectorAll("canvas").forEach((c) => { const p = c.parentElement; if (p && window.echarts) { const i = window.echarts.getInstanceByDom(p); if (i) i.resize(); } }); } catch (_) {}
          window.dispatchEvent(new Event("resize"));
        });
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (_) {}

    page._slideSize = { w: size.w, h: size.h };
    page._blocked = blocked;
    return page;
  }

  async function close() {
    await browser.close();
    server.close();
  }

  return { load, close, base };
}

// Rewrite CDN <link>/<script> hrefs in the raw HTML so the browser requests our
// loopback origin directly (belt-and-suspenders alongside request interception).
function rewriteAssetLinks(html, base) {
  return html
    .replace(/https?:\/\/[^"']*tailwind[^"']*\.css/gi, base + "/assets/tailwind/tailwind.generated.css")
    .replace(/https?:\/\/[^"']*(?:fontawesome|font-awesome)[^"']*\.css/gi, base + "/assets/fontawesome/all.min.css")
    .replace(/https?:\/\/fonts\.googleapis\.com\/css2[^"']*/gi, base + "/assets/fonts/fonts.css");
}

module.exports = { openSession };
