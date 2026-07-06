// src/map.js — the capability ladder. Pure function: extracted element -> emit op.
//
// Ladder (most-editable first):
//   1. text  -> native text runs
//   2. shape -> native rect / roundRect / ellipse (solid fill + border)
//   3. table -> native table
//   4. chart -> (Task #5) native chart where data recoverable, else image
//   5. approximate-native -> gradient->solid, icon->glyph/shape (Task #5)
//   6. last-resort image  -> per-element clip (svg art, gradients, icons for now)
//
// Every element yields exactly one op (nothing dropped). Boxes stay in source px;
// the emitter scales to inches.

const { parseColor } = require("./util");

function mapElement(el) {
  switch (el.kind) {
    case "text":
      return { op: "text", box: el.box, align: el.align, valign: el.valign, lineHeight: el.lineHeight, runs: el.runs, clipped: el.clipped };

    case "table":
      return { op: "table", box: el.box, rows: el.rows };

    case "table-image":
      // rich/clipped table -> faithful image of the visible region
      return { op: "image", box: el.box, needsClip: true, reason: "table", clipId: el.clipId };

    case "shape": {
      // decorative glow orb -> faithful image (solidifying would make a hard block)
      if (el.glow) return { op: "image", box: el.box, needsClip: true, reason: "glow", clipId: el.clipId };
      const fill = parseColor(el.fill);
      let fillColor = fill.hex && fill.alpha > 0.05 ? { hex: fill.hex, alpha: fill.alpha } : null;
      // rung 5: approximate a gradient to its average solid color (keeps it native/editable)
      if (!fillColor && el.gradient && el.gradientSolid) {
        const gs = parseColor(el.gradientSolid);
        if (gs.hex) fillColor = { hex: gs.hex, alpha: 1 };
      }
      const shapeType = el.ellipse ? "ellipse" : el.radius > 0.5 ? "roundRect" : "rect";
      const border = el.border && parseColor(el.border.color).alpha > 0.05
        ? { color: parseColor(el.border.color).hex, width: el.border.width, style: el.border.style }
        : null;
      return {
        op: "shape",
        box: el.box,
        shapeType,
        radiusPx: el.radius,
        fill: fillColor,
        border,
        rotation: el.rotation || 0,
        // gradient -> approximated to solid; shadows dropped (rung 5).
      };
    }

    case "chart":
      // Task #5 upgrades recoverable charts to native; default keeps fidelity via clip.
      return { op: "image", box: el.box, needsClip: true, reason: "chart", clipId: el.clipId };

    case "icon":
      // Task #5 upgrades common icons to native glyph/shape; default clip keeps them crisp.
      return { op: "image", box: el.box, needsClip: true, reason: "icon", faClass: el.faClass, clipId: el.clipId, clipped: el.clipped };

    case "svg":
      return { op: "image", box: el.box, needsClip: true, reason: "svg", clipId: el.clipId };

    case "img":
      return { op: "image", box: el.box, needsClip: true, reason: "img", src: el.src, clipId: el.clipId };

    default:
      return { op: "image", box: el.box, needsClip: true, reason: el.kind, clipId: el.clipId };
  }
}

function mapAll(extracted) {
  return {
    size: extracted.size,
    background: extracted.background,
    textCharCount: extracted.textCharCount,
    ops: extracted.elements.map(mapElement),
  };
}

module.exports = { mapAll, mapElement };
