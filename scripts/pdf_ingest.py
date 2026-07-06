#!/usr/bin/env python3
# Ingest a PDF: render each page to a PNG (background) and extract its native text
# layer (bbox + size + color) when present. Pages with no text layer are flagged for
# OCR by the Node side.
#
#   python pdf_ingest.py <pdf> <outDir>   ->  prints JSON to stdout
#
# JSON: { "pages": [ { "index", "w", "h", "image", "hasText", "spans":[
#          {"text","x","y","w","h","size","color"} ] } ] }

import sys, os, json
import fitz  # PyMuPDF

# keep MuPDF's recoverable warnings off stdout so the JSON output stays clean
try:
    fitz.TOOLS.mupdf_display_errors(False)
except Exception:
    pass

SCALE = 2  # render scale

def sample_bg(pix, x0, y0, x1, y1):
    # median colour of a ring just OUTSIDE the text bbox (usually the background),
    # so we can cover the baked-in text and place clean editable text on top.
    xs = [x0, (x0 + x1) // 2, x1]
    pts = []
    for x in xs:
        pts.append((x, y0 - 3)); pts.append((x, y1 + 3))
    pts.append((x0 - 3, (y0 + y1) // 2)); pts.append((x1 + 3, (y0 + y1) // 2))
    cols = []
    for (px, py) in pts:
        if 0 <= px < pix.width and 0 <= py < pix.height:
            cols.append(pix.pixel(px, py))
    if not cols:
        return "FFFFFF"
    cols.sort()
    r, g, b = cols[len(cols) // 2][:3]
    return format((r << 16) | (g << 8) | b, "06X")

def main():
    pdf, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf)
    pages = []
    for i, page in enumerate(doc):
        rect = page.rect
        w, h = round(rect.width), round(rect.height)
        # render at 2x for a crisp background image
        pix = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), alpha=False)
        img_path = os.path.join(out_dir, f"page-{i+1:03d}.png")
        pix.save(img_path)
        spans = []
        d = page.get_text("dict")
        for b in d.get("blocks", []):
            for line in b.get("lines", []):
                for s in line.get("spans", []):
                    t = s.get("text", "").strip()
                    if not t:
                        continue
                    x0, y0, x1, y1 = s["bbox"]
                    c = int(s.get("color", 0)) & 0xFFFFFF
                    bg = sample_bg(pix, round(x0 * SCALE), round(y0 * SCALE), round(x1 * SCALE), round(y1 * SCALE))
                    fl = s.get("flags", 0)
                    spans.append({
                        "text": t,
                        "x": round(x0), "y": round(y0),
                        "w": round(x1 - x0), "h": round(y1 - y0),
                        "size": round(s.get("size", 12), 1),
                        "color": format(c, "06X"),
                        "bg": bg,
                        "bold": 1 if (fl & 16) else 0,
                        "italic": 1 if (fl & 2) else 0,
                        # font class from flags: 4=serif, 8=monospace -> map to a system font
                        "serif": 1 if (fl & 4) else 0,
                        "mono": 1 if (fl & 8) else 0,
                    })
        pages.append({
            "index": i,
            "w": w, "h": h,
            "image": os.path.abspath(img_path),
            "hasText": len(spans) >= 3,   # a real text layer, not a stray artifact
            "spans": spans,
        })
    print(json.dumps({"pages": pages}))

if __name__ == "__main__":
    main()
