#!/usr/bin/env python3
# Decompose a slide IMAGE into native-reconstructable elements:
#   - slide background colour
#   - solid-colour rectangles (cards, headers, accent bars) -> native shapes
#   - residual artwork regions (icons, charts, photos)      -> individual cropped images
# Text regions are provided by the caller (OCR / PDF text layer) and are masked out so
# they don't pollute rect/residual detection.
#
#   python decompose.py <image> <cropDir> <scale>   with JSON [{x,y,w,h}, ...] on stdin
#   -> {"bg":"RRGGBB","rects":[{x,y,w,h,color,radius}],"images":[{x,y,w,h,path}]}
# All output coords are in ITEM units (image px / scale).

import sys, os, json
import numpy as np
import cv2

def qcolor(arr):  # quantize to 32-step buckets for stable colour keys
    return (arr // 32) * 32 + 16

def main():
    img_path, crop_dir, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
    os.makedirs(crop_dir, exist_ok=True)
    bgr = cv2.imread(img_path, cv2.IMREAD_COLOR)
    H, W = bgr.shape[:2]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.int16)

    text_boxes = json.load(sys.stdin)
    text_mask = np.zeros((H, W), np.uint8)
    for t in text_boxes:
        x0 = max(0, int(t["x"] * scale) - 2); y0 = max(0, int(t["y"] * scale) - 2)
        x1 = min(W, int((t["x"] + t["w"]) * scale) + 2); y1 = min(H, int((t["y"] + t["h"]) * scale) + 2)
        text_mask[y0:y1, x0:x1] = 1

    # ---- background colour: dominant quantized colour along the border ----
    border = np.concatenate([rgb[0:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3),
                             rgb[:, 0:8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3)])
    qb = qcolor(border)
    keys, counts = np.unique(qb.reshape(-1, 3), axis=0, return_counts=True)
    bg = keys[np.argmax(counts)].astype(np.int16)
    # refine to true mean of bg-like border pixels
    near = np.abs(border - bg).sum(axis=1) < 60
    if near.any():
        bg = border[near].mean(axis=0).astype(np.int16)
    bg_mask = (np.abs(rgb - bg).sum(axis=2) < 60).astype(np.uint8)

    explained = (bg_mask | text_mask).astype(np.uint8)

    # ---- solid-colour rectangles (cards / bars / headers) ----
    rects = []
    free = (1 - explained).astype(bool)
    q = qcolor(rgb)
    flat = q[free].reshape(-1, 3)
    out_rect_mask = np.zeros((H, W), np.uint8)
    if len(flat):
        keys, counts = np.unique(flat, axis=0, return_counts=True)
        order = np.argsort(-counts)[:14]  # top candidate colours by coverage
        min_area = int(0.002 * W * H)
        for oi in order:
            col = keys[oi]
            if counts[oi] < min_area:
                continue
            m = ((np.abs(rgb - col.astype(np.int16)).sum(axis=2) < 45) & ~explained.astype(bool)).astype(np.uint8)
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
            n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
            for i in range(1, n):
                x, y, w, h, area = stats[i]
                if area < min_area or w < 20 or h < 12:
                    continue
                # text sitting ON the card was masked out of the colour mask, punching
                # holes — credit those pixels back when judging rectangular-ness.
                tcredit = int(text_mask[y:y + h, x:x + w].sum())
                fill = (area + tcredit) / float(w * h)
                if fill < 0.72:
                    continue
                if w * h > 0.93 * W * H:  # that's a background, not a card
                    continue
                comp = labels[y:y + h, x:x + w] == i
                colour = rgb[y:y + h, x:x + w][comp].mean(axis=0)
                # corner-radius heuristic: unfilled corner cell -> rounded card
                c = 6
                tl = comp[:c, :c].mean() < 0.35
                tr = comp[:c, -c:].mean() < 0.35
                radius = 10 if (tl and tr) else 0
                rects.append({
                    "x": round(x / scale, 1), "y": round(y / scale, 1),
                    "w": round(w / scale, 1), "h": round(h / scale, 1),
                    "color": "%02X%02X%02X" % tuple(int(v) for v in colour),
                    "radius": round(radius / scale, 1),
                    "_area": int(area),
                })
                out_rect_mask[y:y + h, x:x + w][comp] = 1
        explained = (explained | out_rect_mask).astype(np.uint8)

    # ---- residual artwork: everything not bg / rect / text ----
    resid = ((1 - explained) & (1 - text_mask)).astype(np.uint8)
    resid = cv2.morphologyEx(resid, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    resid = cv2.dilate(resid, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(resid, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 140 or max(w, h) < 12:
            continue
        comps.append((area, x, y, w, h))
    comps.sort(reverse=True)
    comps = comps[:48]

    # Text EMBEDDED in a large art region (chart axis labels, diagram annotations) must
    # stay baked into the crop — replacing it visibly would deface the art. Standalone
    # text is inpainted out of the crops so it can be visibly replaced without doubling.
    big_area = 0.02 * W * H
    pad = int(0.025 * W)  # axis labels / annotations hug the chart just outside its bbox
    bigs = [(x - pad, y - pad, w + 2 * pad, h + 2 * pad) for (a, x, y, w, h) in comps if w * h > big_area]
    embedded = []
    inpaint_mask = text_mask.copy()
    for ti, t in enumerate(text_boxes):
        tx0, ty0 = t["x"] * scale, t["y"] * scale
        tx1, ty1 = tx0 + t["w"] * scale, ty0 + t["h"] * scale
        ta = max((tx1 - tx0) * (ty1 - ty0), 1)
        for (bx, by, bw, bh) in bigs:
            ox = max(0, min(tx1, bx + bw) - max(tx0, bx))
            oy = max(0, min(ty1, by + bh) - max(ty0, by))
            if ox * oy / ta >= 0.6:
                embedded.append(ti)
                x0i, y0i = max(0, int(tx0) - 2), max(0, int(ty0) - 2)
                x1i, y1i = min(W, int(tx1) + 2), min(H, int(ty1) + 2)
                inpaint_mask[y0i:y1i, x0i:x1i] = 0  # keep these pixels in the crop
                break

    clean = bgr
    if inpaint_mask.any():
        clean = cv2.inpaint(bgr, (inpaint_mask * 255).astype(np.uint8), 3, cv2.INPAINT_TELEA)

    images = []
    for idx, (area, x, y, w, h) in enumerate(comps):
        px0 = max(0, x - 2); py0 = max(0, y - 2)
        px1 = min(W, x + w + 2); py1 = min(H, y + h + 2)
        crop = clean[py0:py1, px0:px1]
        p = os.path.join(crop_dir, "el-%03d.png" % idx)
        cv2.imwrite(p, crop)
        images.append({
            "x": round(px0 / scale, 1), "y": round(py0 / scale, 1),
            "w": round((px1 - px0) / scale, 1), "h": round((py1 - py0) / scale, 1),
            "path": os.path.abspath(p),
        })

    rects.sort(key=lambda r: -r["_area"])
    for r in rects:
        del r["_area"]
    print(json.dumps({
        "bg": "%02X%02X%02X" % tuple(int(v) for v in bg),
        "rects": rects,
        "images": images,
        "embedded": embedded,  # indices of text items baked into art (emit as invisible)
    }))

if __name__ == "__main__":
    main()
