// src/normalize.js — turn assorted input into an ordered list of single-slide HTML strings.
//
// Accepts:
//   - a folder of .html files (sorted by filename)
//   - one or more .html / .txt files, where a .txt (or .html) may CONCATENATE
//     multiple slide documents (each starting with <!DOCTYPE html>)
//   - raw HTML strings
//
// Returns: [{ name, html }] in slide order.

const fs = require("fs");
const path = require("path");

// Split a blob that may contain several concatenated slides. Auto-detects boundaries in
// order of specificity: full documents (<!DOCTYPE html> or <html>), then bare slide
// bodies (<div class="slide-container">). Falls back to one slide.
function splitDocuments(content) {
  const t = (content || "").trim();
  if (!t) return [];

  // 1. multiple full documents delimited by <!DOCTYPE html>
  if ((t.match(/<!DOCTYPE html>/gi) || []).length > 1) {
    return t.split(/(?=<!DOCTYPE html>)/i).map((p) => p.trim()).filter(Boolean);
  }
  // 2. multiple <html> roots (no/duplicate doctype)
  if ((t.match(/<html[\s>]/gi) || []).length > 1) {
    return t.split(/(?=<html[\s>])/i).map((p) => p.trim()).filter(Boolean);
  }
  // 3. multiple bare slide bodies: <div ... class="... slide-container ...">
  if ((t.match(/class\s*=\s*["'][^"']*\bslide-container\b/gi) || []).length > 1) {
    return t.split(/(?=<div[^>]*class\s*=\s*["'][^"']*\bslide-container\b)/i).map((p) => p.trim()).filter(Boolean);
  }
  // single slide
  return [t];
}

function titleOf(html, fallback) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return t[1].trim();
  const h = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h) return h[1].replace(/<[^>]+>/g, "").trim().slice(0, 60) || fallback;
  return fallback;
}

// Normalize a list of file paths (and/or a directory) into ordered slides.
function fromPaths(inputs) {
  const files = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      fs.readdirSync(input)
        .filter((f) => /\.html?$/i.test(f))
        .sort()
        .forEach((f) => files.push(path.join(input, f)));
    } else {
      files.push(input);
    }
  }

  const slides = [];
  for (const file of files) {
    const base = path.basename(file).replace(/\.(html?|txt)$/i, "");
    const docs = splitDocuments(fs.readFileSync(file, "utf8"));
    docs.forEach((html, i) => {
      const name = docs.length > 1 ? `${base}-${String(i + 1).padStart(2, "0")}` : base;
      slides.push({ name, title: titleOf(html, name), html });
    });
  }
  return slides;
}

// Normalize raw strings (e.g. pasted content from the UI).
function fromStrings(strings) {
  const slides = [];
  strings.forEach((content, idx) => {
    splitDocuments(content).forEach((html, i) => {
      const name = `slide-${String(slides.length + 1).padStart(2, "0")}`;
      slides.push({ name, title: titleOf(html, name), html });
    });
  });
  return slides;
}

module.exports = { fromPaths, fromStrings, splitDocuments, titleOf };
