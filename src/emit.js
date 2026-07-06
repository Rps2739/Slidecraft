// src/emit.js — turn mapped ops into native pptxgenjs objects on a slide.
//
// Scales the source canvas (e.g. 1280x720 or 1920x1080, both 16:9) to the
// 13.333x7.5in deck. Emits native text / shapes / tables; for image ops it
// clips just that element from the rendered page (rung 6). Returns a per-op
// strategy report for the validator.

const { hexOf, systemFont, alignOf, dashOf } = require("./util");

const LAYOUT = { w: 13.333, h: 7.5 };

// Letterbox-fit the source content region into the 13.333x7.5in deck: uniform scale to
// contain, centered. When the content is 16:9 (the common case) this is edge-to-edge with
// no offset; when overflow grew the region, it scales down + centers so nothing is cut.
function fitTransform(size) {
  const s = Math.min(LAYOUT.w / size.w, LAYOUT.h / size.h);
  return { s, offX: (LAYOUT.w - size.w * s) / 2, offY: (LAYOUT.h - size.h * s) / 2 };
}

async function emitSlide(pptx, mapped, page, opts = {}) {
  const PptxGenJS = require("pptxgenjs");
  const S = pptx.ShapeType;
  const slide = pptx.addSlide();
  const { s, offX, offY } = fitTransform(mapped.size);
  const inX = (px) => +(offX + px * s).toFixed(3); // x position (with letterbox offset)
  const inY = (px) => +(offY + px * s).toFixed(3); // y position (with letterbox offset)
  const inW = (px) => +(px * s).toFixed(3);        // a width/height/delta (no offset)
  const pt = (px) => +(px * s * 72).toFixed(1);
  const report = [];

  const bgHex = hexOf(mapped.background, "FFFFFF");
  slide.background = { color: bgHex };

  for (const o of mapped.ops) {
    const b = o.box;
    const pos = { x: inX(b.x), y: inY(b.y), w: Math.max(inW(b.w), 0.05), h: Math.max(inW(b.h), 0.05) };

    if (o.op === "text") {
      const runs = [];
      o.runs.forEach((r, i) => {
        if (r.br) { if (runs.length) runs[runs.length - 1].options.breakLine = true; return; }
        runs.push({
          text: r.text,
          options: {
            color: hexOf(r.color, "000000"),
            fontSize: Math.max(pt(r.size), 1),
            bold: !!r.bold,
            italic: !!r.italic,
            fontFace: systemFont(r.font),
            subscript: !!r.sub || undefined,
            superscript: !!r.sup || undefined,
          },
        });
      });
      if (!runs.length) { report.push({ strategy: "empty", box: b }); continue; }
      // PowerPoint renders fonts slightly wider than Chromium, so a box tightened to
      // Chromium's text width wraps prematurely. Single-line source text -> keep on one
      // line (no wrap) and let shrink handle any overflow; multi-line -> add width
      // headroom so lines break where the source broke them. `fit:shrink` guarantees no
      // overflow either way.
      const maxPx = Math.max(...o.runs.map((r) => r.size || 0), 1);
      const singleLine = b.h < maxPx * 1.7;
      const align = alignOf(o.align);
      const addIn = singleLine ? inW(maxPx * 3) : inW(b.w) * 0.04 + inW(8);
      let tx = pos.x, tw = pos.w + addIn;
      // distribute the added width per alignment so the text's anchor doesn't move
      if (align === "center") tx = pos.x - addIn / 2;
      else if (align === "right") tx = pos.x - addIn;
      tx = Math.max(0, tx);
      tw = Math.min(tw, LAYOUT.w - tx);
      slide.addText(runs, {
        x: tx, y: pos.y, w: tw, h: pos.h,
        align,
        valign: "top",
        margin: 0,
        lineSpacingMultiple: 1.0,
        fit: "shrink", // Layer-1 guard: text can never overflow its box
        wrap: !singleLine,
      });
      const maxSize = Math.max(...o.runs.map((r) => r.size || 0));
      report.push({ strategy: "native-text", box: b, size: maxSize, clipped: o.clipped });
      continue;
    }

    if (o.op === "shape") {
      const type = o.shapeType === "ellipse" ? S.ellipse : o.shapeType === "roundRect" ? S.roundRect : S.rect;
      const fill = o.fill ? { color: o.fill.hex, transparency: Math.round((1 - o.fill.alpha) * 100) } : { type: "none" };
      // px -> pt at deck scale (s converts px->in; *72 -> pt). CSS borders draw inside
      // the box while pptx lines straddle the path, so thick borders are slightly
      // reduced (×0.85) to compensate; floor keeps hairlines visible.
      const line = o.border
        ? { color: o.border.color, width: Math.max(o.border.width * s * 72 * 0.85, 0.5), dashType: dashOf(o.border.style) }
        : { type: "none" };
      const shapeOpts = { ...pos, fill, line, rotate: o.rotation || 0 };
      if (o.shapeType === "roundRect") {
        // pptxgenjs rectRadius is in inches; clamp to half the smaller side
        shapeOpts.rectRadius = Math.min(inW(o.radiusPx || 0), Math.min(pos.w, pos.h) / 2);
      }
      slide.addShape(type, shapeOpts);
      report.push({ strategy: "native-shape", box: b });
      continue;
    }

    if (o.op === "table") {
      const rows = o.rows.map((row) =>
        row.map((c) => ({
          text: c.text || " ",
          options: {
            bold: !!c.bold,
            color: hexOf(c.color, "222222"),
            fill: c.fill ? { color: hexOf(c.fill) } : undefined,
            align: alignOf(c.align),
            valign: "middle",
            fontSize: Math.max(pt(c.size || 13), 7), // real per-cell font size
            fontFace: "Arial",
          },
        }))
      );
      if (rows.length) {
        // real column widths: use the widest row's cell pixel widths, normalized to the
        // table's emitted width (falls back to even columns when unmeasured).
        const widest = o.rows.reduce((a, r) => (r.length > a.length ? r : a), o.rows[0]);
        const pxSum = widest.reduce((t, c) => t + (c.wpx || 0), 0);
        const colW = pxSum > 0 && widest.every((c) => c.wpx > 0)
          ? widest.map((c) => +((c.wpx / pxSum) * pos.w).toFixed(3))
          : undefined;
        slide.addTable(rows, {
          x: pos.x, y: pos.y, w: pos.w, colW,
          border: { type: "solid", color: "D9D9D9", pt: 1 },
          autoPage: false,
        });
        report.push({ strategy: "native-table", box: b });
      }
      continue;
    }

    if (o.op === "image") {
      if (page && o.needsClip) {
        try {
          const b64 = await clip(page, b, opts.originOffset, o.clipId);
          slide.addImage({ data: "image/png;base64," + b64, ...pos });
          report.push({ strategy: "image", reason: o.reason, box: b, clipped: o.clipped });
        } catch (e) {
          report.push({ strategy: "image-failed", reason: o.reason, box: b, error: String(e.message || e) });
        }
      } else {
        report.push({ strategy: "image-skipped", reason: o.reason, box: b });
      }
      continue;
    }
  }

  return { report, size: mapped.size, background: bgHex };
}

// Emit a DECOMPOSED image slide: instead of one full-slide picture, rebuild the slide
// from native elements — background colour fill, native rectangles for detected cards/
// bars, individual cropped images for artwork (icons/charts/photos), and real visible
// text boxes. The result behaves like a normal hand-made PPT slide.
function emitDecomposedSlide(pptx, slide) {
  const s = pptx.addSlide();
  const size = { w: slide.width, h: slide.height };
  const { s: sc, offX, offY } = fitTransform(size);
  const inX = (px) => +(offX + px * sc).toFixed(3);
  const inY = (px) => +(offY + px * sc).toFixed(3);
  const inW = (px) => +(px * sc).toFixed(3);
  const pt = (px) => +(px * sc * 72).toFixed(1);
  const d = slide.decomp;
  const report = [];
  const S = pptx.ShapeType;

  s.background = { color: (d.bg || "FFFFFF").replace("#", "") };

  // 1. card/bar rectangles (largest first — already sorted by the decomposer)
  for (const r of d.rects || []) {
    const rounded = (r.radius || 0) > 0.5;
    s.addShape(rounded ? S.roundRect : S.rect, {
      x: inX(r.x), y: inY(r.y), w: Math.max(inW(r.w), 0.03), h: Math.max(inW(r.h), 0.03),
      fill: { color: (r.color || "FFFFFF").replace("#", "") }, line: { type: "none" },
      rectRadius: rounded ? Math.min(inW(r.radius), inW(Math.min(r.w, r.h)) / 2) : 0,
    });
    report.push({ strategy: "native-shape", box: { x: r.x, y: r.y, w: r.w, h: r.h } });
  }

  // 2. artwork crops as individual movable pictures
  for (const im of d.images || []) {
    s.addImage({ path: im.path, x: inX(im.x), y: inY(im.y), w: Math.max(inW(im.w), 0.03), h: Math.max(inW(im.h), 0.03) });
    report.push({ strategy: "image", reason: "art", box: { x: im.x, y: im.y, w: im.w, h: im.h } });
  }

  // 3. text: visible editable boxes. Standalone text was inpainted out of the art crops
  //    (never doubles); text EMBEDDED in a chart/diagram stays baked in the crop and gets
  //    an invisible (still editable) layer; low-confidence OCR lines stay invisible too.
  const embedded = new Set(d.embedded || []);
  let ti = -1;
  for (const it of slide.items || []) {
    ti++;
    const t = (it.text || "").trim();
    if (!t) continue;
    const visible = !embedded.has(ti) && (it.conf == null || it.conf >= 65);
    const face = it.serif ? "Georgia" : it.mono ? "Consolas" : "Arial";
    s.addText([{ text: t, options: visible
      ? { color: (it.color || "000000").replace("#", ""), bold: !!it.bold, italic: !!it.italic }
      : { color: "808080", transparency: 100 } }], {
      x: inX(it.x), y: inY(it.y),
      w: Math.max(inW(it.w) * 1.15 + 0.05, 0.2),
      h: Math.max(inW(it.h) * 1.25, 0.12),
      fontSize: Math.max(pt(it.size), 5),
      valign: "top", margin: 0, fit: "shrink", wrap: false, fontFace: face,
    });
    report.push({ strategy: visible ? "text-replace" : "text-layer", box: { x: it.x, y: it.y, w: it.w, h: it.h } });
  }

  return { report, size, background: d.bg, imageSlide: true, decomposed: true, ocr: !!slide.ocr, invisible: false };
}

// Emit an "image slide" (from a PDF page or image): a full-bleed background image with
// a layer of editable native text boxes over the detected text — so a screenshot/PDF of
// slides becomes an editable deck. Reuses the same letterbox-fit as HTML slides.
function emitImageSlide(pptx, slide, opts = {}) {
  const s = pptx.addSlide();
  const size = { w: slide.width, h: slide.height };
  const { s: sc, offX, offY } = fitTransform(size);
  const inX = (px) => +(offX + px * sc).toFixed(3);
  const inY = (px) => +(offY + px * sc).toFixed(3);
  const inW = (px) => +(px * sc).toFixed(3);
  const pt = (px) => +(px * sc * 72).toFixed(1);

  s.background = { color: "FFFFFF" };
  // full-slide background image (preserves all visuals exactly)
  s.addImage({ path: slide.image, x: inX(0), y: inY(0), w: inW(size.w), h: inW(size.h) });

  const report = [];
  const S = pptx.ShapeType;
  // Text layer modes (opts.textMode):
  //  - "visible" (default): reconstruct editable elements — cover each detected text line
  //    with its sampled background colour and place REAL visible text (sampled colour).
  //    Per-line safety: an OCR line with low confidence or a patterned/non-uniform
  //    background (bg=null) stays as an invisible overlay instead of painting over the art.
  //  - "invisible": keep the image pixel-perfect; the whole text layer is transparent but
  //    selectable/editable (used by auto-fix and --overlay-only).
  const mode = opts.textMode || "visible";
  let visibleCount = 0;
  for (const it of slide.items || []) {
    const t = (it.text || "").trim();
    if (!t) continue;
    const confOk = it.conf == null || it.conf >= 65;
    const visible = mode === "visible" && !!it.bg && confOk;
    if (visible) {
      visibleCount++;
      s.addShape(S.rect, {
        x: inX(it.x - 1), y: inY(it.y - 1),
        w: Math.max(inW(it.w + 2), 0.03), h: Math.max(inW(it.h + 2), 0.03),
        fill: { color: (it.bg || "FFFFFF").replace("#", "") }, line: { type: "none" },
      });
    }
    // map the PDF font class to a guaranteed PowerPoint/Windows system font so the
    // editable overlay matches the original as closely as possible.
    const face = it.serif ? "Georgia" : it.mono ? "Consolas" : "Arial";
    const runOpts = visible
      ? { color: (it.color || "000000").replace("#", ""), bold: !!it.bold, italic: !!it.italic }
      : { color: "808080", transparency: 100 }; // invisible, still selectable/editable
    s.addText([{ text: t, options: runOpts }], {
      x: inX(it.x), y: inY(it.y),
      w: Math.max(inW(it.w) * 1.15 + 0.05, 0.2),
      h: Math.max(inW(it.h) * 1.25, 0.12),
      fontSize: Math.max(pt(it.size), 5),
      valign: "top",
      margin: 0,
      fit: "shrink",
      wrap: false,
      fontFace: face,
    });
    report.push({ strategy: visible ? "text-replace" : "text-layer", box: { x: it.x, y: it.y, w: it.w, h: it.h } });
  }
  // "invisible" when no line was visibly replaced (pixel-perfect slide)
  return { report, size, background: "FFFFFF", imageSlide: true, ocr: !!slide.ocr, invisible: visibleCount === 0 };
}

// Clip one element region from the page to a base64 PNG. When a clipId is given,
// ISOLATE that element first (hide everything that isn't it, its ancestors, or its
// descendants) so the clip captures ONLY that element — not foreground content that
// happens to sit over it (e.g. title text over a background pattern).
async function clip(page, box, originOffset = { x: 0, y: 0 }, clipId = null) {
  const region = {
    x: box.x + (originOffset.x || 0),
    y: box.y + (originOffset.y || 0),
    width: Math.max(box.w, 1),
    height: Math.max(box.h, 1),
  };
  if (!clipId) return page.screenshot({ encoding: "base64", clip: region });

  await page.evaluate((id) => {
    const target = document.querySelector(`[data-clip-id="${id}"]`);
    if (!target) return;
    const keep = new Set();
    const ancestors = [];
    let n = target;
    while (n) { keep.add(n); ancestors.push(n); n = n.parentElement; } // ancestors (layout + bg)
    target.querySelectorAll("*").forEach((d) => keep.add(d)); // descendants
    const hidden = [];
    document.querySelectorAll("body *").forEach((el) => {
      if (!keep.has(el) && el.style.visibility !== "hidden") {
        el.dataset._prevVis = el.style.visibility || "";
        el.style.visibility = "hidden";
        hidden.push(el);
      }
    });
    window.__clipHidden = hidden;
  }, clipId);

  let b64;
  try {
    b64 = await page.screenshot({ encoding: "base64", clip: region, omitBackground: true });
  } finally {
    await page.evaluate(() => {
      (window.__clipHidden || []).forEach((el) => {
        el.style.visibility = el.dataset._prevVis || "";
        delete el.dataset._prevVis;
      });
      window.__clipHidden = null;
    });
  }
  return b64;
}

module.exports = { emitSlide, emitImageSlide, emitDecomposedSlide, LAYOUT, fitTransform };
