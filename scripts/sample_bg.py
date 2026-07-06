#!/usr/bin/env python3
# For each text box in an image, sample:
#   bg — the background colour just OUTSIDE the box (null if the surrounding background
#        is not uniform, e.g. text over a chart/gradient — unsafe to paint over)
#   fg — the text colour INSIDE the box (median of pixels far from bg)
#
#   python sample_bg.py <image>   with JSON [{x,y,w,h}, ...] on stdin
#   -> prints JSON [{"bg":"RRGGBB"|null, "fg":"RRGGBB"}, ...]
import sys, json
import numpy as np
from PIL import Image

def main():
    img = Image.open(sys.argv[1]).convert("RGB")
    W, H = img.size
    arr = np.asarray(img, dtype=np.int16)
    boxes = json.load(sys.stdin)
    out = []
    for b in boxes:
        x0, y0 = int(b["x"]), int(b["y"])
        x1, y1 = int(b["x"] + b["w"]), int(b["y"] + b["h"])
        # ring sample points just outside the box
        pts = []
        for x in (x0, (x0 + x1) // 2, x1):
            pts.append((x, y0 - 3)); pts.append((x, y1 + 3))
        pts.append((x0 - 3, (y0 + y1) // 2)); pts.append((x1 + 3, (y0 + y1) // 2))
        cols = [arr[y, x] for (x, y) in pts if 0 <= x < W and 0 <= y < H]
        if not cols:
            out.append({"bg": None, "fg": "000000"}); continue
        cols = np.array(cols)
        med = np.median(cols, axis=0)
        # uniformity: if the ring colours disagree strongly, the bg is patterned -> unsafe
        spread = float(np.max(np.percentile(cols, 90, axis=0) - np.percentile(cols, 10, axis=0)))
        bg = None if spread > 40 else "%02X%02X%02X" % tuple(int(v) for v in med)
        # fg: median of in-box pixels far from the bg colour
        ix0, iy0 = max(0, x0), max(0, y0)
        ix1, iy1 = min(W, x1), min(H, y1)
        fg = "000000"
        if ix1 > ix0 and iy1 > iy0:
            inside = arr[iy0:iy1, ix0:ix1].reshape(-1, 3)
            dist = np.abs(inside - med).sum(axis=1)
            far = inside[dist > 120]
            if len(far) >= 4:
                fgv = np.median(far, axis=0)
                fg = "%02X%02X%02X" % tuple(int(v) for v in fgv)
                # interior purity: a clean text line contains only bg-ish and fg-ish pixels.
                # A large "other" fraction means the box overlaps artwork/diagram content —
                # painting over it would destroy visuals -> mark unsafe.
                dist_fg = np.abs(inside - fgv).sum(axis=1)
                other = np.count_nonzero((dist > 90) & (dist_fg > 90))
                if other / max(len(inside), 1) > 0.15:
                    bg = None
            else:
                # no distinct pixels: pick black/white by bg luminance for contrast
                lum = 0.299 * med[0] + 0.587 * med[1] + 0.114 * med[2]
                fg = "000000" if lum > 128 else "FFFFFF"
        out.append({"bg": bg, "fg": fg})
    print(json.dumps(out))

if __name__ == "__main__":
    main()
