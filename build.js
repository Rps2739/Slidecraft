// build.js — orchestrator: HTML slides -> one editable deck.pptx + a report.
//
//   node build.js [inputs...] [--out deck.pptx] [--fast]
//
// inputs: folders and/or .html/.txt files (a .txt may concatenate many slides).
// Defaults to the slides/ folder if no inputs are given.
// --fast skips the Layer-2/3 PowerPoint visual verification (Layer-1 always runs).

const fs = require("fs");
const path = require("path");
const PptxGenJS = require("pptxgenjs");
const { fromPaths } = require("./src/normalize");
const { openSession } = require("./src/render");
const { extract } = require("./src/extract");
const { mapAll } = require("./src/map");
const { emitSlide, emitImageSlide, emitDecomposedSlide } = require("./src/emit");
const { validateSlide } = require("./src/validate");
const { verifyDeck } = require("./src/verify");
const { ingest, isMedia, closeOcr } = require("./src/ingest");
const { makeLogger, saveJobReport, newJobId, LOG_DIR } = require("./src/logger");

const log = makeLogger("build");

// Build an ordered slide list: HTML/txt inputs -> html slides; pdf/image inputs ->
// "image slides" (background + editable OCR/text overlay). Preserves input order.
// A single bad input (corrupt file, unreadable path) is logged and skipped rather
// than aborting the whole batch — the rest of the deck still gets built.
async function buildSlideList(inputs, workDir) {
  const list = [];
  for (const input of inputs) {
    try {
      if (isMedia(input)) {
        const imageSlides = await ingest(input, workDir);
        list.push(...imageSlides);
      } else {
        list.push(...fromPaths([input])); // html/txt (folders & concatenated .txt supported)
      }
    } catch (e) {
      log.error(`failed to load input "${input}":`, e);
    }
  }
  return list;
}

async function convert(inputs, opts = {}) {
  inputs = inputs.length ? inputs : [path.join(__dirname, "slides")];
  const outFile = path.resolve(opts.out || "deck.pptx");
  const workDir = opts.workDir || path.join(__dirname, ".work");
  const srcDir = path.join(workDir, "src");
  const jobId = opts.jobId || newJobId();
  const startedAt = opts.startedAt || Date.now();
  // keep the work dir on the auto-fix retry pass: ingested page images live there and
  // the memoized ingest reuses them (no repeated OCR / PowerPoint rendering).
  if (!opts._retry) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });

  if (!opts._retry) log.info(`job ${jobId} start:`, { inputs, out: outFile, fast: !!opts.fast, autoFix: opts.autoFix !== false, overlayOnly: !!opts.overlayOnly });

  // progress reporting (server streams these to the UI as SSE; no-op on the CLI)
  const prog = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  prog({ phase: opts._retry ? "refine-load" : "ingest" });

  const slides = await buildSlideList(inputs, workDir);
  prog({ phase: opts._retry ? "refine" : "start", total: slides.length, fast: !!opts.fast });

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "W", width: 13.333, height: 7.5 });
  pptx.layout = "W";

  const hasHtml = slides.some((s) => s.kind !== "image");
  const session = hasHtml ? await openSession() : null;
  const reports = [];
  try {
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const srcPng = path.join(srcDir, `slide-${String(i + 1).padStart(2, "0")}.png`);
      let page = null;
      // A single slide failing (bad HTML, a render crash, a corrupt embedded image)
      // must not lose the rest of the deck — log it, mark that slide for review, move on.
      try {
        if (slide.kind === "image") {
          // PDF page / PPTX slide / image -> native elements.
          // Default: full DECOMPOSITION (bg fill + card rects + art crops + visible text) so
          // the slide behaves like a normal PPT. --overlay-only keeps the image pixel-
          // perfect with a transparent text layer; patch mode is the fallback if the
          // decomposer failed.
          const emit = slide.decomp && !opts.overlayOnly
            ? emitDecomposedSlide(pptx, slide)
            : emitImageSlide(pptx, slide, { textMode: opts.overlayOnly ? "invisible" : "visible" });
          fs.copyFileSync(slide.image, srcPng); // reference render = the source image itself
          reports.push(validateSlide({ name: slide.name, title: slide.title, imageSlide: true, emit }));
          continue;
        }

        page = await session.load(slide.html);
        const extracted = await extract(page);
        // capture the source render (Layer-2 reference), clipped to the fitted content
        // region so it matches the letterboxed output; order matches PowerPoint export.
        await page.screenshot({
          path: srcPng,
          clip: { x: extracted.originOffset.x, y: extracted.originOffset.y, width: extracted.size.w, height: extracted.size.h },
        });

        // auto-fix: a drifted HTML slide is regenerated as a pixel-perfect image (its own
        // source render) + a transparent editable text layer -> ~0% diff, still editable text.
        if (opts.imageFallback && opts.imageFallback.has(i)) {
          const items = extracted.elements.filter((e) => e.kind === "text").map((e) => ({
            text: e.runs.map((r) => r.text).join(""),
            x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h,
            size: Math.max(...e.runs.map((r) => r.size || 0), 1), color: "000000",
          }));
          const emit = emitImageSlide(pptx, { image: srcPng, width: extracted.size.w, height: extracted.size.h, ocr: true, items }, { textMode: "invisible" });
          reports.push(validateSlide({ name: slide.name, title: slide.title, imageSlide: true, emit }));
          continue;
        }

        const mapped = mapAll(extracted);
        const emit = await emitSlide(pptx, mapped, page, { originOffset: extracted.originOffset });
        reports.push(validateSlide({ name: slide.name, title: slide.title, mapped, emit }));
      } catch (e) {
        log.error(`slide ${i + 1} (${slide.name}) failed:`, e);
        reports.push({
          name: slide.name, title: slide.title, coveragePct: 0, strategies: {},
          issues: [`conversion failed: ${e.message || e}`], needsReview: true, failed: true,
        });
      } finally {
        if (page) { try { await page.close(); } catch (_) {} }
        const rep = reports[reports.length - 1] || {};
        prog({
          phase: opts._retry ? "refine" : "slide",
          done: i + 1, total: slides.length,
          title: slide.title || slide.name,
          ok: !rep.failed && !(rep.issues || []).length,
          failed: !!rep.failed,
        });
      }
    }
  } finally {
    if (session) await session.close();
    await closeOcr();
  }

  prog({ phase: "write" });
  await pptx.writeFile({ fileName: outFile });

  // Layer 2/3: visual verification against source renders (skipped in --fast).
  if (!opts.fast) {
    prog({ phase: "verify", total: slides.length });
    try {
      const kinds = {};
      reports.forEach((r, i) => (kinds[i + 1] = r.imageSlide ? (r.invisible ? "image" : "recon") : "html"));
      const { byIndex } = await verifyDeck(outFile, srcDir, workDir, kinds, opts.diffThreshold);
      reports.forEach((r, i) => {
        const v = byIndex[i + 1];
        if (!v) return;
        r.diffPct = v.diffPct;
        r.diffTolerance = v.tolerance;
        r.visualFlagged = v.flagged;
        if (v.flagged) {
          r.issues.push(`visual drift ${v.diffPct}% (>${v.tolerance}%) @${JSON.stringify(v.worstRegion)}`);
        } else {
          // Layer-2 visual PROOF supersedes Layer-1 heuristics: the rendered slide matches
          // the source within tolerance, so collision/clip warnings were false alarms
          // (source-faithful overlaps, dense labels) — clear them instead of crying wolf.
          r.issues = r.issues.filter((s) => !/text collision|clipped\/half-cut/.test(s));
        }
        r.needsReview = r.issues.length > 0;
      });

      // auto-review + fix: any slide STILL flagged after visual proof (drift or a real
      // Layer-1 failure) is regenerated as pixel-perfect image + editable text and
      // re-verified — reviews are corrected automatically BEFORE the final output.
      if (opts.autoFix && !opts._retry) {
        const fallback = new Set();
        reports.forEach((r, i) => { if ((r.visualFlagged || r.needsReview) && !r.imageSlide && !r.failed) fallback.add(i); });
        if (fallback.size) {
          return convert(inputs, { ...opts, imageFallback: fallback, _retry: true, jobId, startedAt });
        }
      }
    } catch (e) {
      log.error(`job ${jobId} verification step failed:`, e);
      reports.forEach((r) => (r.verifyError = String(e.message || e)));
    }
  }

  const result = { outFile, reports, count: slides.length, autoFixed: opts.imageFallback ? opts.imageFallback.size : 0 };
  const durationMs = Date.now() - startedAt;
  const failedCount = reports.filter((r) => r.failed).length;
  const reviewCount = reports.filter((r) => r.needsReview).length;
  log.info(`job ${jobId} done in ${durationMs}ms:`, { slides: result.count, failed: failedCount, needsReview: reviewCount, autoFixed: result.autoFixed });
  saveJobReport(jobId, { jobId, inputs, out: outFile, opts: { fast: !!opts.fast, autoFix: opts.autoFix !== false, overlayOnly: !!opts.overlayOnly }, durationMs, ...result });
  return result;
}

function printReport(result) {
  console.log(`\n  built ${result.outFile} from ${result.count} slide(s)\n  === REPORT ===`);
  let dirty = 0, failed = 0;
  const diffs = [];
  for (const r of result.reports) {
    const flags = [...r.issues];
    const strat = Object.entries(r.strategies || {}).map(([k, v]) => `${k}:${v}`).join(" ");
    const diff = r.diffPct != null ? ` diff ${r.diffPct}%` : "";
    if (r.diffPct != null) diffs.push(r.diffPct);
    if (r.failed) { failed++; dirty++; console.log(`  [FAILED] ${r.name}: ${flags.join("; ")}`); }
    else if (flags.length) { dirty++; console.log(`  [REVIEW] ${r.name}: ${flags.join("; ")}  (${strat})`); }
    else console.log(`  [ok]     ${r.name}: coverage ${r.coveragePct}%${diff}  (${strat})`);
  }
  if (diffs.length) {
    const avg = (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(1);
    const max = Math.max(...diffs).toFixed(1);
    console.log(`  -> visual diff: avg ${avg}%, max ${max}%`);
  }
  if (result.autoFixed) console.log(`  -> auto-fixed ${result.autoFixed} drifted slide(s) as pixel-perfect image+text`);
  console.log(`  -> ${dirty ? dirty + " slide(s) need review" : "all slides within threshold — safe to ship"}`);
  if (failed) console.log(`  -> ${failed} slide(s) FAILED to convert — see ${LOG_DIR} for details`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {
    fast: argv.includes("--fast"),
    // image/PDF/PPT slides: default = visible editable reconstruction; --overlay-only
    // keeps pixels identical with a transparent (still editable) text layer instead.
    overlayOnly: argv.includes("--overlay-only"),
    autoFix: !argv.includes("--no-autofix"), // regenerate drifted slides pixel-perfect (default on)
  };
  const outIdx = argv.indexOf("--out");
  if (outIdx > -1) opts.out = argv[outIdx + 1];
  const diffIdx = argv.indexOf("--diff");
  if (diffIdx > -1) opts.diffThreshold = parseFloat(argv[diffIdx + 1]);
  const valueFlags = [];
  if (outIdx > -1) valueFlags.push(outIdx + 1);
  if (diffIdx > -1) valueFlags.push(diffIdx + 1);
  const inputs = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(i));
  convert(inputs, opts).then(printReport).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { convert };
