// src/ingest.js — turn PDFs and images into "image slides" (a background image + a
// layer of editable native text boxes), so a PDF/screenshot of slides becomes an
// EDITABLE deck.
//
// PDF with a real text layer  -> text taken directly from the PDF (no OCR).
// PDF page without text / image -> OCR (tesseract.js, offline with vendored data).
//
// Returns slides: { name, title, kind:"image", image, width, height, items:[
//   {text,x,y,w,h,size,color,bold} ] }

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { makeLogger } = require("./logger");
const { pythonCall } = require("./pyresolve");

const log = makeLogger("ingest");
const ROOT = path.resolve(__dirname, "..");

// spawn a python script robustly (resolved interpreter), returning stdout
function runPy(scriptAndArgs) { const c = pythonCall(scriptAndArgs); return run(c.file, c.args); }
function runPyInput(scriptAndArgs, input) { const c = pythonCall(scriptAndArgs); return runInput(c.file, c.args, input); }

const isMedia = (p) => /\.(pdf|pptx?|png|jpe?g|webp|bmp|tiff?)$/i.test(p);
const isImage = (p) => /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(p);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err || `exit ${c}`))));
    p.on("error", reject);
  });
}

// ---- OCR (tesseract.js) ----
let _worker = null;
async function ocrWorker() {
  if (_worker) return _worker;
  const { createWorker } = require("tesseract.js");
  const tessdata = path.join(ROOT, "assets", "tessdata");
  const opts = {};
  // use vendored language data for fully-offline OCR when present
  if (fs.existsSync(path.join(tessdata, "eng.traineddata")) || fs.existsSync(path.join(tessdata, "eng.traineddata.gz"))) {
    opts.langPath = tessdata;
    opts.gzip = fs.existsSync(path.join(tessdata, "eng.traineddata.gz"));
    opts.cachePath = tessdata;
  }
  _worker = await createWorker("eng", 1, opts);
  return _worker;
}

function runInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err || `exit ${c}`))));
    p.on("error", reject);
    p.stdin.write(input); p.stdin.end();
  });
}

async function ocrImage(imgPath) {
  let data;
  try {
    const worker = await ocrWorker();
    ({ data } = await worker.recognize(imgPath, {}, { blocks: true }));
  } catch (e) {
    // OCR failing shouldn't kill the whole slide/deck — log it and degrade to "no text
    // detected" (the slide still ships as a background image).
    log.error(`OCR failed for ${imgPath}:`, e);
    return [];
  }
  // words are nested blocks -> paragraphs -> lines -> words; use LINE level for clean,
  // natural editable text runs.
  const items = [];
  for (const blk of data.blocks || []) {
    for (const para of blk.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = (line.text || "").replace(/\s+/g, " ").trim();
        if (!text || (line.confidence != null && line.confidence < 35)) continue;
        const lh = line.bbox.y1 - line.bbox.y0;
        // Tesseract merges side-by-side columns/cells into one "line". Split it into
        // segments at large word gaps so each column gets its own box (otherwise a
        // single cover-rect would paint across unrelated content).
        const words = (line.words || []).filter((w) => w.text && w.text.trim());
        const segs = [];
        if (words.length) {
          let cur = null;
          const flush = () => {
            if (!cur) return;
            // trim junk edge words: icon glyphs OCR'd as symbols ("#", "g°", "♻" -> "2%")
            // — low-confidence short tokens, or short tokens that are mostly non-alphanumeric.
            const junk = (w) => {
              const t = w.text.trim();
              if ((w.confidence ?? 100) < 55 && t.length <= 3) return true;
              const alnum = (t.match(/[a-z0-9]/gi) || []).length;
              return t.length <= 2 && alnum < t.length; // "#", "g°", "©" etc.
            };
            let ws = cur.ws;
            while (ws.length && junk(ws[0])) ws = ws.slice(1);
            while (ws.length && junk(ws[ws.length - 1])) ws = ws.slice(0, -1);
            if (!ws.length) { cur = null; return; }
            segs.push({
              text: ws.map((w) => w.text.trim()).join(" "),
              x0: Math.min(...ws.map((w) => w.bbox.x0)), y0: Math.min(...ws.map((w) => w.bbox.y0)),
              x1: Math.max(...ws.map((w) => w.bbox.x1)), y1: Math.max(...ws.map((w) => w.bbox.y1)),
              confs: ws.map((w) => w.confidence),
            });
            cur = null;
          };
          for (const w of words) {
            const gapThresh = Math.max(2.2 * lh, 28);
            if (cur && w.bbox.x0 - cur.x1 > gapThresh) flush();
            if (!cur) cur = { ws: [w], x1: w.bbox.x1 };
            else { cur.ws.push(w); cur.x1 = Math.max(cur.x1, w.bbox.x1); }
          }
          flush();
        } else {
          const b = line.bbox;
          segs.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, confs: [line.confidence] });
        }
        for (const sg of segs) {
          const confs = sg.confs.filter((c) => c != null);
          items.push({
            text: sg.text,
            x: sg.x0, y: sg.y0, w: sg.x1 - sg.x0, h: sg.y1 - sg.y0,
            size: (sg.y1 - sg.y0) * 0.78,
            conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : line.confidence,
            color: "000000",
            bold: false,
          });
        }
      }
    }
  }
  // sample background + text colour for each line: bg (null if the surrounding area is
  // patterned/unsafe to paint over) drives visible replacement; fg is the text colour.
  if (items.length) {
    try {
      const samples = JSON.parse(await runPyInput([path.join(ROOT, "scripts", "sample_bg.py"), imgPath],
        JSON.stringify(items.map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h })))));
      items.forEach((it, i) => {
        const s = samples[i] || {};
        it.bg = s.bg || null;
        it.color = s.fg || "000000";
      });
    } catch (e) {
      log.warn(`background sampling failed for ${imgPath} — text will stay as an invisible overlay:`, e.message || e);
    }
  }
  return items;
}

async function closeOcr() {
  if (_worker) { await _worker.terminate(); _worker = null; }
}

// ---- element decomposition (image -> bg + rect shapes + art crops) ----
// Returns { bg, rects:[{x,y,w,h,color,radius}], images:[{x,y,w,h,path}] } or null.
async function decomposeImage(imgPath, cropDir, scale, items) {
  try {
    // `safe` = this line can be VISIBLY replaced (uniform sampled background + confident
    // text — the exact gate emit uses for visibility). The decomposer uses it to inpaint
    // such text OUT of art crops instead of baking it in as uneditable pixels (e.g. a
    // name plate under a photo: the plate stays in the picture, the name becomes a real
    // editable text box on top).
    const out = await runPyInput(
      [path.join(ROOT, "scripts", "decompose.py"), imgPath, cropDir, String(scale)],
      JSON.stringify((items || []).map((it) => ({
        x: it.x, y: it.y, w: it.w, h: it.h,
        safe: it.bg && (it.conf == null || it.conf >= 65) ? 1 : 0,
      }))));
    const start = out.indexOf('{"bg"');
    return JSON.parse(start >= 0 ? out.slice(start) : out.trim());
  } catch (e) {
    log.error(`element decomposition failed for ${imgPath} — falling back to patch/overlay mode:`, e);
    return null; // fall back to patch/overlay mode
  }
}

// ---- PDF ----
async function ingestPdf(pdfPath, workDir) {
  const outDir = path.join(workDir, "pdf-" + path.basename(pdfPath).replace(/\W+/g, "_"));
  fs.mkdirSync(outDir, { recursive: true });
  let json;
  try {
    json = await runPy([path.join(ROOT, "scripts", "pdf_ingest.py"), pdfPath, outDir]);
  } catch (e) {
    log.error(`PDF ingest failed for ${pdfPath} (is Python + PyMuPDF installed?):`, e);
    throw e;
  }
  // robustly extract the JSON object (any stray library warnings before it are ignored)
  const start = json.indexOf('{"pages"');
  const { pages } = JSON.parse(start >= 0 ? json.slice(start) : json.trim());
  const base = path.basename(pdfPath).replace(/\.pdf$/i, "");
  const slides = [];
  for (const pg of pages) {
    let items;
    if (pg.hasText) {
      items = pg.spans;
    } else {
      // scanned/screenshot page -> OCR the rendered image (coords are in 2x image px)
      const ocr = await ocrImage(pg.image);
      items = ocr.map((it) => ({ ...it, x: it.x / 2, y: it.y / 2, w: it.w / 2, h: it.h / 2, size: it.size / 2 }));
    }
    // decompose the page into native elements (bg + card rects + art crops)
    const decomp = await decomposeImage(pg.image, path.join(outDir, `els-${pg.index + 1}`), 2, items);
    slides.push({
      name: `${base}-${String(pg.index + 1).padStart(2, "0")}`,
      title: `${base} p${pg.index + 1}`,
      kind: "image",
      image: pg.image,
      width: pg.w,
      height: pg.h,
      ocr: !pg.hasText,
      items,
      decomp,
    });
  }
  return slides;
}

// ---- single image ----
async function ingestImage(imgPath, workDir) {
  const sizeOf = require("./imgsize");
  const { w, h } = sizeOf(imgPath);
  const items = await ocrImage(imgPath);
  const base = path.basename(imgPath).replace(/\.[^.]+$/, "");
  const cropDir = path.join(workDir || path.dirname(imgPath), "els-" + base.replace(/\W+/g, "_"));
  const decomp = await decomposeImage(path.resolve(imgPath), cropDir, 1, items);
  return [{ name: base, title: base, kind: "image", image: path.resolve(imgPath), width: w, height: h, ocr: true, items, decomp }];
}

// ---- PPTX: render each slide to an image (PowerPoint), then OCR -> editable overlay.
// Makes a deck of non-editable slide images (e.g. a Canva/Gamma export) editable, and
// doubles as a PPTX->PDF path via the download-pdf endpoint.
async function ingestPptx(pptxPath, workDir) {
  // PPTX input renders each slide with PowerPoint (COM), which is Windows + Office only.
  if (require("os").platform() !== "win32") {
    throw new Error("PPTX input needs PowerPoint (Windows only) — unavailable on this host. Use HTML, PDF, or image inputs here.");
  }
  const base = path.basename(pptxPath).replace(/\.pptx?$/i, "");
  const outDir = path.join(workDir, "pptx-" + base.replace(/\W+/g, "_"));
  fs.mkdirSync(outDir, { recursive: true });
  const script = path.join(ROOT, "scripts", "export_pptx.ps1");
  // render at 2x for sharper OCR; item coords stay in image px (scale=2 for decompose,
  // then everything is divided back to slide units below)
  try {
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Pptx", pptxPath, "-OutDir", outDir, "-Width", "2560", "-Height", "1440"]);
  } catch (e) {
    log.error(`PPTX render failed for ${pptxPath} (is PowerPoint installed?):`, e);
    throw e;
  }
  const sizeOf = require("./imgsize");
  const pngs = fs.readdirSync(outDir).filter((f) => /\.png$/i.test(f)).sort();
  const slides = [];
  for (let i = 0; i < pngs.length; i++) {
    const imgPath = path.join(outDir, pngs[i]);
    const { w, h } = sizeOf(imgPath);
    const items = await ocrImage(imgPath);
    const decomp = await decomposeImage(imgPath, path.join(outDir, `els-${i + 1}`), 1, items);
    slides.push({
      name: `${base}-${String(i + 1).padStart(2, "0")}`,
      title: `${base} slide ${i + 1}`,
      kind: "image", image: imgPath, width: w, height: h, ocr: true, items, decomp,
    });
  }
  return slides;
}

// Memoize ingest per (path, mtime, size): the auto-fix pass re-runs convert(), and
// re-ingesting would repeat OCR / PowerPoint rendering for nothing. Keyed by mtime+size
// so re-uploaded files with the same name are re-processed.
const _ingestCache = new Map();
async function ingest(filePath, workDir) {
  let key = null;
  try {
    const st = fs.statSync(filePath);
    key = `${path.resolve(filePath)}|${st.mtimeMs}|${st.size}|${workDir}`;
    const hit = _ingestCache.get(key);
    // only reuse if the rendered page images still exist on disk
    if (hit && hit.every((s) => fs.existsSync(s.image))) return hit;
  } catch (_) {}
  let slides = [];
  if (/\.pdf$/i.test(filePath)) slides = await ingestPdf(filePath, workDir);
  else if (/\.pptx?$/i.test(filePath)) slides = await ingestPptx(filePath, workDir);
  else if (isImage(filePath)) slides = await ingestImage(filePath, workDir);
  if (key && slides.length) _ingestCache.set(key, slides);
  return slides;
}

module.exports = { ingest, isMedia, isImage, closeOcr };
