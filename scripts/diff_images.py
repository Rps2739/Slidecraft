#!/usr/bin/env python3
# Compare source-render PNGs vs PowerPoint-render PNGs for each slide.
# Emits JSON: [{ "slide": "slide-01", "diffPct": 3.1, "worstRegion": [x,y,w,h] }, ...]
#
#   python diff_images.py <srcDir> <outDir>
#
# diffPct = mean per-pixel absolute difference as a percentage (0 = identical).
# worstRegion = the 1/6 x 1/6 grid cell with the highest difference (for locating drift).

import sys, os, json
from PIL import Image
import numpy as np

def load(path, size):
    im = Image.open(path).convert("RGB").resize(size)
    return np.asarray(im, dtype=np.float32)

def letterbox(im, tw, th, bg=(255, 255, 255)):
    # scale to contain within (tw,th) and pad — mirrors the emitter's letterbox-fit, so
    # an overflow-fitted source (content-only) compares fairly against the 16:9 output.
    w, h = im.size
    s = min(tw / w, th / h)
    nw, nh = max(1, int(w * s)), max(1, int(h * s))
    canvas = Image.new("RGB", (tw, th), bg)
    canvas.paste(im.resize((nw, nh)), ((tw - nw) // 2, (th - nh) // 2))
    return canvas

def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    SIZE = (640, 360)  # downscale for a fast, layout-level comparison
    GX, GY = 6, 6
    results = []
    names = sorted(f for f in os.listdir(src_dir) if f.lower().endswith(".png"))
    for name in names:
        sp = os.path.join(src_dir, name)
        op = os.path.join(out_dir, name)
        if not os.path.exists(op):
            results.append({"slide": os.path.splitext(name)[0], "diffPct": None, "missing": True})
            continue
        out_im = Image.open(op).convert("RGB")
        src_im = Image.open(sp).convert("RGB")
        # normalize the source into the output's frame (letterbox) before comparing
        src_lb = letterbox(src_im, out_im.width, out_im.height)
        a = np.asarray(src_lb.resize(SIZE), dtype=np.float32)
        b = np.asarray(out_im.resize(SIZE), dtype=np.float32)
        diff = np.abs(a - b).mean(axis=2)   # per-pixel mean abs diff (0..255)
        # "significantly different" pixels only -> robust to anti-aliasing over large
        # solid areas, but catches real drift (duplicated/missing text, moved content).
        THRESH = 45
        changed = (diff > THRESH).astype(np.float32)
        diff_pct = float(changed.mean() * 100.0)
        # worst grid cell by changed fraction
        cw, ch = SIZE[0] // GX, SIZE[1] // GY
        worst, worst_val = None, -1
        for gy in range(GY):
            for gx in range(GX):
                cell = changed[gy*ch:(gy+1)*ch, gx*cw:(gx+1)*cw]
                v = float(cell.mean())
                if v > worst_val:
                    worst_val = v
                    sx, sy = 1280 / SIZE[0], 720 / SIZE[1]
                    worst = [int(gx*cw*sx), int(gy*ch*sy), int(cw*sx), int(ch*sy)]
        results.append({
            "slide": os.path.splitext(name)[0],
            "diffPct": round(diff_pct, 2),
            "worstRegion": worst,
            "worstPct": round(worst_val * 100.0, 2),
        })
    print(json.dumps(results))

if __name__ == "__main__":
    main()
