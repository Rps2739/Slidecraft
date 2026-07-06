// src/imgsize.js — read PNG/JPEG pixel dimensions from the file header (no deps).
const fs = require("fs");

module.exports = function imgsize(file) {
  const buf = fs.readFileSync(file);
  // PNG: 8-byte sig, then IHDR with width/height at bytes 16..24
  if (buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOF marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return { w: 1280, h: 720 }; // fallback
};
