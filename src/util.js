// src/util.js — shared conversions used by the mapper and emitter.

const PX_PER_IN = 96;

// Scale factor is applied by the emitter (source canvas -> 13.333x7.5in deck).
const px2in = (px) => px / PX_PER_IN;
const px2pt = (px) => px * 0.75;

// Parse "rgb(r,g,b)" / "rgba(r,g,b,a)" -> { hex, alpha }.
function parseColor(str) {
  if (!str) return { hex: null, alpha: 0 };
  const m = String(str).match(/rgba?\(([^)]+)\)/i);
  if (!m) {
    // maybe already a hex
    const h = String(str).replace("#", "");
    return /^[0-9a-f]{6}$/i.test(h) ? { hex: h.toUpperCase(), alpha: 1 } : { hex: null, alpha: 0 };
  }
  const p = m[1].split(",").map((s) => parseFloat(s.trim()));
  const [r, g, b] = p;
  const a = p.length === 4 ? p[3] : 1;
  const hex = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  return { hex: hex.toUpperCase(), alpha: a };
}

const hexOf = (str, fallback = null) => parseColor(str).hex || fallback;

// Map a computed font-family stack to a single face name for PowerPoint.
function faceOf(fontFamily) {
  if (!fontFamily) return "Arial";
  const first = fontFamily.split(",")[0].replace(/['"]/g, "").trim();
  return first || "Arial";
}

// Fonts that ship with Windows/Office — safe to reference directly.
const INSTALLED = new Set([
  "arial", "arial narrow", "arial black", "calibri", "calibri light", "cambria", "candara",
  "consolas", "constantia", "corbel", "courier new", "georgia", "impact", "lucida console",
  "lucida sans unicode", "palatino linotype", "segoe ui", "segoe ui semibold", "segoe ui light",
  "tahoma", "times new roman", "trebuchet ms", "verdana", "bahnschrift", "comic sans ms",
  "franklin gothic medium", "gabriola", "sylfaen", "symbol", "webdings", "wingdings",
]);

// Map an arbitrary (often web-only) font stack to a font that is ACTUALLY installed, so
// PowerPoint doesn't do its own substitution — which on this pipeline intermittently
// renders correct text as garbled accented glyphs. Web fonts (Inter, Oswald, Roboto Mono,
// etc.) are classified by kind and mapped to the closest guaranteed Windows/Office font.
function systemFont(fontFamily) {
  if (!fontFamily) return "Arial";
  const first = fontFamily.split(",")[0].replace(/['"]/g, "").trim();
  if (INSTALLED.has(first.toLowerCase())) return first;
  const s = fontFamily.toLowerCase();
  if (/\bmono|consol|courier|menlo|monaco|cascadia|source ?code|fira ?code|jetbrains|ibm plex mono|ubuntu mono/.test(s)) return "Consolas";
  if (/condensed|narrow|oswald|bebas|anton|barlow ?condensed|archivo ?narrow|pathway/.test(s)) return "Arial Narrow";
  if ((/\bserif\b/.test(s) && !/sans/.test(s)) ||
      /times|georgia|garamond|merriweather|playfair|\blora\b|pt ?serif|noto ?serif|source ?serif|cambria|roboto ?slab|spectral|bitter|libre ?baskerville/.test(s)) return "Georgia";
  return "Arial"; // default: a neutral installed sans for Inter/Roboto/Helvetica/etc.
}

// Map CSS text-align to pptx align.
const alignOf = (a) => (a === "center" || a === "right" || a === "justify" ? (a === "justify" ? "left" : a) : "left");

// CSS border-style -> pptx dashType.
const dashOf = (style) => (style === "dashed" ? "dash" : style === "dotted" ? "sysDot" : "solid");

module.exports = { PX_PER_IN, px2in, px2pt, parseColor, hexOf, faceOf, systemFont, alignOf, dashOf };
