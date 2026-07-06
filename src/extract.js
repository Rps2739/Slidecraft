// src/extract.js — walk the rendered DOM and produce a normalized element list.
//
// Runs inside the page (via page.evaluate). Reads RESOLVED geometry
// (getBoundingClientRect) and computed styles, so it works identically whether
// layout came from inline styles, flexbox, grid, or Tailwind.
//
// Output: { size:{w,h}, background, textCharCount, elements:[ ... ] }
// Each element has a `kind` and everything the mapper/emitter needs:
//   text  -> { kind, box, align, valign, runs:[{text,color,size,bold,italic,font}] }
//   shape -> { kind, box, fill, border, radius, ellipse, opacity, rotation, gradient, shadow }
//   table -> { kind, box, rows:[[{text,bold,color,fill,align}]] }
//   svg   -> { kind, box }                  (clip to image, or approximate)
//   img   -> { kind, box, src }
//   icon  -> { kind, box, faClass, color, size }   (Font Awesome <i>)
//   chart -> { kind, box }                  (data-object-type="chart" region)

async function extract(page) {
  return page.evaluate(() => {
    const INLINE = new Set(["SPAN", "B", "STRONG", "EM", "I", "A", "U", "SMALL", "MARK", "SUB", "SUP", "BR", "LABEL", "CODE"]);
    const BLOCK_TEXTLESS_SKIP = new Set(["SCRIPT", "STYLE", "META", "LINK", "HEAD"]);

    const container = document.querySelector(".slide-container") || document.body;
    const origin = container.getBoundingClientRect();
    const canvas = { w: Math.round(origin.width) || 1280, h: Math.round(origin.height) || 720 };
    // Reveal overflow and take the true content extent as the working bound, so content
    // taller/wider than the declared canvas is captured (not clipped mid-text). A later
    // pass fits the meaningful content back into the slide.
    container.style.overflow = "visible";
    const bound = {
      w: Math.max(canvas.w, Math.round(container.scrollWidth) || canvas.w),
      h: Math.max(canvas.h, Math.round(container.scrollHeight) || canvas.h),
    };
    const size = { w: canvas.w, h: canvas.h };

    // Clamp a viewport-space rect to the working content bound (canvas grown to fit
    // overflow). Returns null if fully outside.
    const clampRect = (r) => {
      const x0 = r.left - origin.left, y0 = r.top - origin.top;
      const x1 = x0 + r.width, y1 = y0 + r.height;
      const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
      const cx1 = Math.min(bound.w, x1), cy1 = Math.min(bound.h, y1);
      if (cx1 - cx0 < 0.5 || cy1 - cy0 < 0.5) return null;
      return { x: Math.round(cx0), y: Math.round(cy0), w: Math.round(cx1 - cx0), h: Math.round(cy1 - cy0) };
    };
    // Intersect a viewport-space rect with every scroll/overflow-hidden ancestor, so
    // content clipped by a fixed-height scroll card (e.g. a table showing 5 of 13 rows)
    // is bounded to what's actually visible in the source.
    const ancestorClip = (el, r) => {
      let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
      let n = el.parentElement;
      while (n) {
        const s = getComputedStyle(n);
        if (/hidden|auto|scroll|clip/.test(s.overflow + s.overflowX + s.overflowY)) {
          const cr = n.getBoundingClientRect();
          x0 = Math.max(x0, cr.left); y0 = Math.max(y0, cr.top);
          x1 = Math.min(x1, cr.right); y1 = Math.min(y1, cr.bottom);
        }
        if (n === container) break;
        n = n.parentElement;
      }
      return { left: x0, top: y0, right: x1, bottom: y1, width: x1 - x0, height: y1 - y0 };
    };
    const boxOf = (el) => clampRect(ancestorClip(el, el.getBoundingClientRect()));
    // Icons/badges often straddle a card edge and get clipped by the card's overflow:hidden
    // (used for rounded corners), which cuts them in half. They're small and meant to be
    // seen whole, so bound them only to the canvas — not their container.
    const boxWhole = (el) => clampRect(el.getBoundingClientRect());

    // Tight bounds of an element's actual rendered TEXT (via a Range) — the element's
    // own box is often far wider than its text (e.g. a full-width title holding a short
    // left-aligned string), which would cause phantom overlaps. Falls back to the box.
    const textBoxOf = (el) => {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        if (r.width > 0.5 && r.height > 0.5) return clampRect(ancestorClip(el, r));
      } catch (_) {}
      return boxOf(el);
    };
    const visible = (el, cs) => {
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0.5 && r.height > 0.5;
    };
    const alpha = (rgb) => {
      const m = rgb && rgb.match(/rgba?\(([^)]+)\)/);
      if (!m) return 0;
      const parts = m[1].split(",").map((s) => parseFloat(s));
      return parts.length === 4 ? parts[3] : 1;
    };
    const hasFill = (cs) => alpha(cs.backgroundColor) > 0.02;
    const hasBorder = (cs) => {
      const w = Math.max(parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderLeftWidth) || 0, parseFloat(cs.borderBottomWidth) || 0, parseFloat(cs.borderRightWidth) || 0);
      return w > 0.4 && alpha(cs.borderTopColor || cs.borderColor) > 0.02;
    };
    const rotationOf = (cs) => {
      const t = cs.transform;
      if (!t || t === "none") return 0;
      const m = t.match(/matrix\(([^)]+)\)/);
      if (!m) return 0;
      const v = m[1].split(",").map(parseFloat);
      const angle = Math.round((Math.atan2(v[1], v[0]) * 180) / Math.PI);
      return angle;
    };
    // Occlusion test: is this element painted over by an unrelated opaque element?
    // Samples points across its box; if every sample's topmost element is neither the
    // element, a descendant, nor an ancestor, it's hidden behind something (e.g. text
    // behind a footer bar) and must not be emitted.
    const occluded = (el) => {
      const r = el.getBoundingClientRect();
      const ys = r.top + r.height / 2;
      const pts = [
        [r.left + r.width / 2, ys],
        [r.left + Math.min(r.width * 0.2, r.width - 1) + 1, ys],
        [r.left + Math.max(r.width * 0.8, 1) - 1, ys],
      ];
      let tested = 0, occ = 0;
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
        tested++;
        const top = document.elementFromPoint(x, y);
        if (top && (top === el || el.contains(top) || top.contains(el))) continue;
        occ++;
      }
      return tested > 0 && occ === tested;
    };

    const directText = (el) =>
      Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
    const hasBlockChild = (el) =>
      Array.from(el.children).some((c) => !INLINE.has(c.tagName) && c.tagName !== "svg" && c.tagName !== "IMG" && !(c.tagName === "I" && /\bfa[srlbd]?\b|\bfa-/.test(c.className)));
    const faClassOf = (el) => {
      const cls = (typeof el.className === "string" ? el.className : "") || "";
      const m = cls.match(/\bfa-[a-z0-9-]+/g);
      return cls.match(/\bfa[srlbd]?\b/) && m ? cls.match(/\bfa[srlbd]?\b/)[0] + " " + m.join(" ") : null;
    };

    // Collect ordered inline runs for a text leaf (one level deep; covers "GO in green").
    const runsOf = (el) => {
      const runs = [];
      const push = (text, cs) => {
        const t = text.replace(/\s+/g, " ");
        if (!t.trim()) return;
        runs.push({
          text: t,
          color: cs.color,
          size: parseFloat(cs.fontSize),
          bold: parseInt(cs.fontWeight) >= 600 || cs.fontWeight === "bold",
          italic: cs.fontStyle === "italic",
          font: cs.fontFamily,
        });
      };
      const parentCs = getComputedStyle(el);
      el.childNodes.forEach((n) => {
        if (n.nodeType === 3) push(n.textContent, parentCs);
        else if (n.nodeType === 1) {
          if (n.tagName === "BR") { runs.push({ text: "\n", br: true }); return; }
          push(n.textContent, getComputedStyle(n));
          // preserve sub/superscript (x², CO₂, footnote markers) as run flags
          if (n.tagName === "SUB" || n.tagName === "SUP") {
            const last = runs[runs.length - 1];
            if (last) last[n.tagName === "SUB" ? "sub" : "sup"] = true;
          }
        }
      });
      return runs;
    };

    const tableData = (tbl) => {
      const rows = [];
      tbl.querySelectorAll("tr").forEach((tr) => {
        const cells = [];
        tr.querySelectorAll("th,td").forEach((c) => {
          const cs = getComputedStyle(c);
          cells.push({
            text: c.textContent.replace(/\s+/g, " ").trim(),
            bold: parseInt(cs.fontWeight) >= 600 || c.tagName === "TH",
            color: cs.color,
            fill: hasFill(cs) ? cs.backgroundColor : null,
            align: cs.textAlign,
            size: parseFloat(cs.fontSize) || 13,           // real cell font size (px)
            wpx: c.getBoundingClientRect().width || 0,     // real column width (px)
          });
        });
        if (cells.length) rows.push(cells);
      });
      return rows;
    };

    const elements = [];
    let textCharCount = 0;
    // stacking order: tag each element with the z-index of its nearest positioned
    // ancestor chain (approx) so floating badges (z-20) render on top regardless of DOM order.
    let curZ = 0;
    const pushEl = (o) => { o.z = curZ; elements.push(o); };
    // Tag elements that may be image-clipped so the emitter can isolate them.
    let clipCounter = 0;
    const tagClip = (el) => {
      const id = "c" + ++clipCounter;
      el.setAttribute("data-clip-id", id);
      return id;
    };

    // Iterative DFS with subtree-skip.
    const stack = [container];
    const skip = new Set();
    while (stack.length) {
      const el = stack.pop();
      if (skip.has(el)) continue;
      if (el.nodeType !== 1 || BLOCK_TEXTLESS_SKIP.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const isContainer = el === container;

      if (!isContainer && !visible(el, cs)) { continue; }

      // effective stacking z: nearest self-or-ancestor with an explicit z-index
      curZ = (() => {
        let n = el;
        while (n && n !== document.body) {
          const zs = getComputedStyle(n).zIndex;
          if (zs && zs !== "auto") return parseInt(zs) || 0;
          n = n.parentElement;
        }
        return 0;
      })();

      const dObj = el.getAttribute && el.getAttribute("data-object-type");
      const box = isContainer ? { x: 0, y: 0, w: size.w, h: size.h } : boxOf(el);
      // fully off-canvas (clipped by overflow:hidden) -> not visible; skip element & subtree
      if (!isContainer && !box) continue;

      // --- special kinds that consume their subtree ---
      if (!isContainer) {
        if (dObj === "chart") {
          pushEl({ kind: "chart", box, clipId: tagClip(el) });
          el.querySelectorAll("*").forEach((d) => skip.add(d));
          continue;
        }
        if (el.tagName === "TABLE") {
          // A table with icons/pills/badges in cells, or one clipped to fewer rows than
          // it contains, can't be faithfully reproduced as a native pptx table -> image.
          const richCell = !!el.querySelector("svg, i, img") ||
            Array.from(el.querySelectorAll("td,th")).some((c) =>
              Array.from(c.children).some((ch) => alpha(getComputedStyle(ch).backgroundColor) > 0.05));
          const clipped = el.getBoundingClientRect().height - box.h > 8;
          if (richCell || clipped) {
            pushEl({ kind: "table-image", box, clipId: tagClip(el) });
          } else {
            pushEl({ kind: "table", box, rows: tableData(el) });
            textCharCount += el.textContent.replace(/\s+/g, "").length;
          }
          el.querySelectorAll("*").forEach((d) => skip.add(d));
          continue;
        }
        if (el.tagName === "svg") {
          pushEl({ kind: "svg", box, clipId: tagClip(el) });
          el.querySelectorAll("*").forEach((d) => skip.add(d));
          continue;
        }
        // <canvas> (ECharts/Chart.js render a chart here) -> capture as an image
        if (el.tagName === "CANVAS") {
          pushEl({ kind: "svg", box, clipId: tagClip(el) });
          continue;
        }
        if (el.tagName === "IMG") {
          pushEl({ kind: "img", box, src: el.getAttribute("src"), clipId: tagClip(el) });
          continue;
        }
        const fa = el.tagName === "I" ? faClassOf(el) : null;
        if (fa) {
          if (!occluded(el)) {
            const whole = boxWhole(el);
            const clipped = whole && box && (box.w * box.h) < 0.6 * (whole.w * whole.h);
            pushEl({ kind: "icon", box, faClass: fa, color: cs.color, size: parseFloat(cs.fontSize), clipId: tagClip(el), clipped });
          }
          el.querySelectorAll("*").forEach((d) => skip.add(d));
          continue;
        }
      }

      // --- shape contribution (background / border), for containers & cards ---
      const rawGradient = cs.backgroundImage && cs.backgroundImage.includes("gradient") ? cs.backgroundImage : null;
      // A gradient with a small tiled background-size is a decorative PATTERN (dot grid,
      // texture), not a fill — averaging it to a solid would paint a big flat block over
      // the slide. Treat patterns as decoration and drop them.
      const bgSize = cs.backgroundSize || "";
      const isPattern = rawGradient && /\d/.test(bgSize) &&
        bgSize.split(/[\s,]+/).some((v) => { const n = parseFloat(v); return n > 0 && n <= 64; });
      const gradient = isPattern ? null : rawGradient;
      // A glow gradient (fades to transparent) on a decorative element with no inner
      // content is a soft orb/halo — solidifying it makes an ugly hard block, so image it.
      const isGlow = gradient && /transparent|rgba\([^)]*,\s*0(\.0+)?\s*\)/.test(gradient);
      const decorativeGlow = isGlow && (el.textContent || "").trim().length === 0;
      // approximate a gradient to its average color -> keeps the element native/editable
      // and avoids image-clipping a container (which would bake in its children).
      const gradientSolid = gradient
        ? (() => {
            const cols = gradient.match(/rgba?\([^)]+\)/g) || [];
            if (!cols.length) return null;
            let r = 0, g = 0, b = 0, n = 0;
            cols.forEach((c) => { const p = c.match(/[\d.]+/g).map(Number); r += p[0]; g += p[1]; b += p[2]; n++; });
            return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
          })()
        : null;
      if (!isContainer && (hasFill(cs) || hasBorder(cs) || gradient)) {
        // percentage radii (e.g. border-radius:50% = circle) come back as "50%", not px
        const radiusOf = (v) => {
          const n = parseFloat(v) || 0;
          return /%/.test(v || "") ? (n / 100) * Math.min(box.w, box.h) : n;
        };
        const radius = Math.max(radiusOf(cs.borderTopLeftRadius), radiusOf(cs.borderTopRightRadius));
        const ellipse = radius > 0 && Math.abs(radius - Math.min(box.w, box.h) / 2) < 3;
        pushEl({
          kind: "shape",
          box,
          glow: decorativeGlow || undefined,
          clipId: decorativeGlow ? tagClip(el) : undefined,
          fill: hasFill(cs) ? cs.backgroundColor : null,
          gradient,
          gradientSolid,
          border: hasBorder(cs)
            ? { color: cs.borderTopColor, width: parseFloat(cs.borderTopWidth), style: cs.borderTopStyle }
            : null,
          radius,
          ellipse,
          opacity: parseFloat(cs.opacity),
          rotation: rotationOf(cs),
          shadow: cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow : null,
        });
      }

      // --- text contribution (only for text leaves: no block children) ---
      if (!isContainer) {
        const txt = directText(el);
        const inlineOnly = !hasBlockChild(el);
        if (txt && inlineOnly && occluded(el)) {
          // hidden behind an opaque element in the source -> not visible; skip
          el.querySelectorAll("*").forEach((d) => skip.add(d));
          continue;
        }
        if (txt && inlineOnly) {
          const runs = runsOf(el);
          if (runs.length) {
            const tbox = textBoxOf(el) || box;
            // detect text cut off by a container (e.g. a rotated/edge label losing a letter)
            let clipped = false;
            try {
              const rng = document.createRange(); rng.selectNodeContents(el);
              const nat = rng.getBoundingClientRect();
              if (nat.width * nat.height > 0) clipped = tbox.w * tbox.h < 0.75 * nat.width * nat.height;
            } catch (_) {}
            pushEl({
              kind: "text",
              box: tbox,
              align: cs.textAlign,
              valign: "top",
              lineHeight: parseFloat(cs.lineHeight) || null,
              runs,
              clipped,
            });
            textCharCount += runs.map((r) => (r.text || "").replace(/\s+/g, "").length).reduce((a, b) => a + b, 0);
            // its inline children are covered by runs; skip them — EXCEPT media (img/svg/
            // canvas/icon glyphs), which runs can't represent: re-visit those so an inline
            // image or icon inside a text block isn't silently dropped.
            const isMedia = (d) => d.tagName === "IMG" || d.tagName === "svg" || d.tagName === "CANVAS" ||
              (d.tagName === "I" && /\bfa[srlbd]?\b|\bfa-/.test(typeof d.className === "string" ? d.className : ""));
            el.querySelectorAll("*").forEach((d) => { if (!isMedia(d)) skip.add(d); });
            Array.from(el.querySelectorAll("img, svg, canvas, i")).forEach((d) => { if (isMedia(d)) stack.push(d); });
            continue;
          }
        }
      }

      // recurse into children (reverse to preserve document order with pop)
      const kids = Array.from(el.children);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }

    // ---- overflow fit: grow the canvas to include meaningful overflowing content ----
    // Measure the extent of real content (text, tables, icons, images, cards) — NOT
    // full-canvas backgrounds or pure decoration — then fit that whole region into the
    // slide (emit letterboxes it). This turns "content cut off by overflow:hidden" into
    // "content scaled to fit", so nothing is lost.
    // Only real content grows the canvas — NOT bare shapes (a decorative circle/orb that
    // sticks out past the edge is meant to be clipped, not to enlarge the slide). Text
    // inside overflowing cards extends the bounds on its own.
    const isContentEl = (e) =>
      e.kind === "text" || e.kind === "table" || e.kind === "table-image" || e.kind === "icon" || e.kind === "img";
    let cMaxX = canvas.w, cMaxY = canvas.h;
    for (const e of elements) {
      if (!isContentEl(e)) continue;
      cMaxX = Math.max(cMaxX, e.box.x + e.box.w);
      cMaxY = Math.max(cMaxY, e.box.y + e.box.h);
    }
    const fit = { w: Math.min(cMaxX, bound.w), h: Math.min(cMaxY, bound.h) };
    // re-clamp every element to the fitted canvas; drop anything now fully outside it
    const fitted = [];
    for (const e of elements) {
      const b = e.box;
      const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
      const x1 = Math.min(b.x + b.w, fit.w), y1 = Math.min(b.y + b.h, fit.h);
      if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
      e.box = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      fitted.push(e);
    }
    // stable sort by stacking z (V8 sort is stable) so higher-z elements emit on top
    fitted.forEach((e, i) => (e._i = i));
    fitted.sort((a, b) => (a.z || 0) - (b.z || 0) || a._i - b._i);
    fitted.forEach((e) => delete e._i);

    // Effective slide background: container's own, else body's (demo decks set it on <body>), else white.
    const containerBg = getComputedStyle(container).backgroundColor;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const background = alpha(containerBg) > 0.02 ? containerBg : alpha(bodyBg) > 0.02 ? bodyBg : "rgb(255,255,255)";
    const originOffset = { x: Math.round(origin.left), y: Math.round(origin.top) };
    return { size: fit, canvas, overflow: fit.w > canvas.w + 1 || fit.h > canvas.h + 1, background, originOffset, textCharCount, elements: fitted };
  });
}

module.exports = { extract };
