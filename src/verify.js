// src/verify.js — Layer 2/3: visual verification of the output deck.
//
// Renders the finished .pptx with the installed PowerPoint (authoritative oracle),
// pixel-diffs each slide against its source render, and returns per-slide drift
// scores. Slides whose drift exceeds tolerance are flagged NEEDS REVIEW (Layer-3
// slide-level failsafe). All local; no network.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { makeLogger } = require("./logger");
const { pythonCall } = require("./pyresolve");

const log = makeLogger("verify");
const ROOT = path.resolve(__dirname, "..");
// Type-aware diff thresholds (% of significantly-different pixels):
//  - image: slide keeps the untouched source image (invisible text layer) -> near-pixel-perfect.
//  - recon: image slide with VISIBLY reconstructed text (cover + substitute font) -> the
//    replacement inherently differs a few % per line; the bar catches real damage only.
//  - html: native reconstruction. The render step now forces the SAME installed-font
//    substitution the emitter uses (see render.js), so browser vs PowerPoint no longer
//    differ by font FAMILY — but they still differ by rendering engine (anti-aliasing,
//    sub-pixel hinting, bold synthesis), which on dense grid slides is a genuine ~6-7%
//    floor. 8% keeps faithfully-reconstructed slides native (editable) while real layout
//    breakage (misplaced/missing elements) still lands well above it and gets auto-fixed.
const DIFF_TOLERANCE = { image: 2.0, recon: 12.0, html: 8.0 };

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
    p.on("error", reject);
  });
}

// Export the pptx to per-slide PNGs via installed PowerPoint.
async function exportPptx(pptxPath, outDir) {
  const script = path.join(ROOT, "scripts", "export_pptx.ps1");
  try {
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Pptx", pptxPath, "-OutDir", outDir]);
  } catch (e) {
    log.error(`PowerPoint export failed for ${pptxPath} (verification skipped for this run):`, e);
    throw e;
  }
}

// Diff two dirs of matching slide PNGs -> array of { slide, diffPct, worstRegion }.
async function diffDirs(srcDir, outDir) {
  try {
    const c = pythonCall([path.join(ROOT, "scripts", "diff_images.py"), srcDir, outDir]);
    const py = await run(c.file, c.args);
    return JSON.parse(py.trim());
  } catch (e) {
    log.error(`image diff failed (${srcDir} vs ${outDir}):`, e);
    throw e;
  }
}

// Full verification pass. `srcDir` holds slide-NN.png source renders (captured at
// convert time). `kinds[i]` is "image" or "html" for slide i (1-based) to pick the
// threshold; `override` (if set) forces a single threshold for all slides.
async function verifyDeck(pptxPath, srcDir, workDir, kinds = {}, override = null) {
  const outDir = path.join(workDir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  await exportPptx(pptxPath, outDir);
  const diffs = await diffDirs(srcDir, outDir);
  const byIndex = {};
  diffs.forEach((d, i) => {
    const idx = i + 1;
    const tol = override != null ? override : DIFF_TOLERANCE[kinds[idx] || "html"];
    byIndex[idx] = {
      diffPct: d.diffPct,
      worstRegion: d.worstRegion,
      worstPct: d.worstPct,
      tolerance: tol,
      flagged: d.diffPct == null || d.diffPct > tol,
    };
  });
  return { byIndex, outDir, tolerance: DIFF_TOLERANCE };
}

module.exports = { verifyDeck, exportPptx, diffDirs, DIFF_TOLERANCE };
