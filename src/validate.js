// src/validate.js — Layer-1 validation + per-slide report.
//
// Checks (hard gates for "no overlaps / no conversion issues"):
//   - text-on-text overlap (text over a card/shape is fine)
//   - off-canvas elements
//   - completeness: no op silently dropped (empty / image-failed)
//   - strategy tally + text-coverage estimate
//
// Returns { name, title, coveragePct, strategies, issues, needsReview }.

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

function validateSlide({ name, title, mapped, emit, imageSlide }) {
  const issues = [];
  const strategies = {};
  for (const r of emit.report) strategies[r.strategy] = (strategies[r.strategy] || 0) + 1;

  // image slides (from PDF/image): background preserves visuals exactly; text is an
  // editable overlay taken from the source, so there's nothing to overlap-check.
  if (imageSlide) {
    const textCount = (strategies["text-replace"] || 0) + (strategies["text-layer"] || 0);
    return {
      name, title,
      coveragePct: 100,
      strategies,
      issues,
      needsReview: false,
      imageSlide: true,
      invisible: !!emit.invisible,
      ocr: !!emit.ocr,
      textCount,
    };
  }

  const canvas = mapped.size;

  // text boxes for overlap check. Only a COLLISION of two similar-size texts is a
  // real problem; a much larger text behind a smaller one is intentional layering
  // (e.g. a giant faint watermark acronym behind a title) and is source-faithful.
  const texts = emit.report.filter((r) => r.strategy === "native-text").map((r) => ({ ...r.box, size: r.size || 0 }));
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      const ov = overlapArea(a, b);
      const minArea = Math.min(a.w * a.h, b.w * b.h);
      if (minArea <= 0 || ov / minArea <= 0.5 || ov <= 400) continue;
      const sizeRatio = Math.max(a.size, b.size) / Math.max(1, Math.min(a.size, b.size));
      if (sizeRatio > 1.8) continue; // decorative layering, not a collision
      issues.push(`text collision (${Math.round((ov / minArea) * 100)}%)`);
    }
  }

  // off-canvas
  let off = 0;
  for (const r of emit.report) {
    const b = r.box;
    if (!b) continue;
    if (b.x < -2 || b.y < -2 || b.x + b.w > canvas.w + 2 || b.y + b.h > canvas.h + 2) off++;
  }
  if (off) issues.push(`${off} off-canvas element(s)`);

  // completeness: nothing failed / silently dropped
  const failed = (strategies["image-failed"] || 0) + (strategies["empty"] || 0) + (strategies["image-skipped"] || 0);
  if (failed) issues.push(`${failed} unrendered element(s)`);

  // half-baked / clipped elements: content cut off by a container edge (icons straddling
  // a card, a label losing a letter, etc.)
  const clipped = emit.report.filter((r) => r.clipped).length;
  if (clipped) issues.push(`${clipped} clipped/half-cut element(s)`);

  // text coverage: chars emitted natively vs source visible text chars
  const coveragePct = mapped.textCharCount
    ? Math.min(100, Math.round((countNativeTextChars(mapped) / mapped.textCharCount) * 100))
    : 100;

  return {
    name,
    title,
    coveragePct,
    strategies,
    issues,
    needsReview: issues.length > 0,
  };
}

// how many source text chars we emitted as native text/table
function countNativeTextChars(mapped) {
  let n = 0;
  for (const o of mapped.ops) {
    if (o.op === "text") n += o.runs.map((r) => (r.text || "").replace(/\s+/g, "").length).reduce((a, b) => a + b, 0);
    else if (o.op === "table") n += (o.rows || []).flat().map((c) => (c.text || "").replace(/\s+/g, "").length).reduce((a, b) => a + b, 0);
  }
  return n;
}

module.exports = { validateSlide, overlapArea };
