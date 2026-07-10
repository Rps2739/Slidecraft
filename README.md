# HTML → Editable PPTX Converter

Convert hand- or AI-authored HTML slides into a **native, fully editable** PowerPoint deck —
real text boxes, shapes, and tables, never a screenshot of a slide. Runs **100% offline** as a
local web app; nothing ever leaves your machine.

## What makes it different

- **Native & editable.** Text, cards, pills, tables, and framework shapes become real PowerPoint
  objects you can click and edit — not flattened images.
- **Works with any HTML.** Renders each slide in a local headless browser and reads the *resolved*
  layout, so it handles inline styles, flexbox, grid, and Tailwind alike (not just absolutely-
  positioned HTML). **Charts render too** — ECharts and Chart.js are vendored locally, so AI-generated
  decks (Genspark, etc.) that draw charts from a CDN still get their charts captured.
- **Also converts PDFs, PPTs & images — into real elements.** A PDF, a flattened-image PPTX, or a
  screenshot of slides is **decomposed like a hand-made deck**: the background becomes a slide fill,
  detected cards/bars become native rectangles, charts/diagrams/photos become individual movable
  pictures (with standalone text inpainted out so nothing doubles), and text becomes real visible
  editable text boxes. Text embedded inside a chart stays baked in (plus an invisible editable
  layer); low-confidence OCR lines stay invisible rather than defacing the slide. Pass
  `--overlay-only` to skip decomposition and keep every pixel identical with a transparent text layer.
- **Never cuts content off.** If a slide's content overflows its canvas, the whole slide is scaled to
  fit (letterboxed) instead of clipped — nothing is lost.
- **Verified correct.** Every converted HTML slide is rendered back with your installed PowerPoint and
  pixel-diffed against the source; slides that drift are flagged for review. No silent breakage.
- **Fully offline.** All assets (Tailwind, Font Awesome, fonts, OCR language data) are vendored locally
  and the renderer blocks every network request. One-time setup pulls open-source npm packages; after
  that, zero internet.

## Setup (one time — needs internet only here)

```bash
npm install        # pulls open-source deps + a headless Chromium
npm run assets     # vendors Tailwind/Font Awesome/fonts into assets/ for offline use
```

## Use it (the app)

```bash
npm start          # opens the local UI at http://127.0.0.1:4599
```

**Or just double-click the "Slidecraft" icon on your Desktop** — no terminal needed. It starts the
server in the background (no visible console window) and opens your browser to it. If it's already
running it just opens a new tab — **unless the code has changed since that server started, in which
case the shortcut automatically restarts it so you always get the latest version.** (A running Node
server holds its code in memory and never re-reads the files, so without this an old background
process would keep serving stale code no matter how many times you edited or relaunched.) To recreate
the shortcut (e.g. after moving the project folder), see `scripts/Slidecraft.vbs` and `scripts/launch.js`.

Drop `.html`, `.txt`, `.pdf`, or image files — **or paste HTML straight into the box**. Multiple slides
are **auto-detected** (by `<!DOCTYPE html>`, `<html>`, or `<div class="slide-container">` boundaries),
so a `.txt`, a paste, or a folder can each hold many slides; a PDF becomes one slide per page. Reorder,
click **Convert**, review the per-slide report, and download `deck.pptx`.

## Use it (command line)

```bash
node build.js "path/to/slides"              # a folder of .html, or .txt/.html files
node build.js slides/*.html --out deck.pptx
node build.js deck.pdf --out deck.pptx      # PDF / image / PPTX -> editable deck
node build.js slides.pptx                    # image-PPT -> editable; also enables PPT->PDF
node build.js deck.pdf --overlay-only       # keep pixels identical (transparent text layer)
node build.js <inputs> --diff 4             # override the visual-diff threshold (%)
node build.js <inputs> --no-autofix         # don't regenerate drifted slides as images
node build.js <inputs> --fast               # skip the PowerPoint visual verification (faster)
```

Accepted inputs: `.html`, `.txt`, pasted HTML, `.pdf`, `.pptx`, and images. Output downloads as
`.pptx` **or `.pdf`**. A `.pptx` input whose slides are flattened images (e.g. a Canva/Gamma export)
becomes editable; it also doubles as a PPT→PDF converter.

**Auto-review & fix (on by default):** after verification, any HTML slide whose visual diff exceeds
the threshold is automatically **regenerated as a pixel-perfect image + transparent editable text
layer** (~0% diff, text still editable) and re-verified — so slides needing review are corrected
before the final output. The report also flags **clipped / half-cut elements** (e.g. an icon badge
cut by its card) and overlap/overflow.

Inputs can be mixed (HTML + PDF + images in one run); output order follows input order.

## Quality gate & diff thresholds

Before the deck is accepted, every slide is checked: overflow is auto-fitted, and overlap /
off-canvas / completeness are validated during conversion; then the output is rendered with PowerPoint
and pixel-diffed against the source. Thresholds are **type-aware** (override with `--diff`):

- **PDF / image slides** — target **≤ 2%** (they keep the source image, so they're pixel-perfect,
  typically **0%**, with a transparent editable text layer).
- **HTML slides** — target **≤ 6%** (native reconstruction has a ~3% floor because browsers and
  PowerPoint render web fonts differently; this catches real layout drift, not font anti-aliasing).

Slides over threshold are flagged `NEEDS REVIEW`; the run prints avg/max diff.

## How it works

Pipeline (`src/`):

1. **normalize** — accept a folder / files / concatenated `.txt`; yield ordered single-slide HTML.
2. **render** — load each slide in a network-sealed headless browser at its real canvas size.
3. **extract** — walk the rendered DOM for resolved geometry + computed styles; clip to visible
   regions; cull occluded elements; measure true text extents.
4. **map** — a *capability ladder* picks the most-editable representation per element: native text →
   shape → table → chart → approximate-native (gradient→solid, etc.) → per-element image only as a
   last resort.
5. **emit** — write native pptxgenjs objects, scaled to a 13.333×7.5in 16:9 deck.
6. **validate** (Layer 1) — overlap / off-canvas / overflow / completeness gates.
7. **verify** (Layer 2/3) — render the `.pptx` with PowerPoint, pixel-diff vs source, flag drift;
   `NEEDS REVIEW` is the backup failsafe so nothing ships broken.

## Requirements

- Node.js 18+
- Python 3 with **PyMuPDF** (PDF render + text), **Pillow**, **NumPy** — for PDF ingest, image diff,
  and background sampling.
- Microsoft PowerPoint (Windows) — used only for the HTML visual-verification step; skip with `--fast`.
  It's safe to keep PowerPoint open while converting: the tool reuses your running instance and never
  closes it or your open presentations.

Everything in the tool itself is open-source (MIT / Apache-2.0 / OFL); PowerPoint is used only as an
optional verification oracle.

## Logs

Every run writes to `logs/` — this is the first place to look if something goes wrong:

- `logs/app-YYYY-MM-DD.log` — everything (one line per event: requests, per-slide progress, errors).
- `logs/error-YYYY-MM-DD.log` — just the warnings/errors, for fast triage.
- `logs/conversions/<jobId>.json` — the full report for one specific conversion (inputs, options,
  every slide's result, timing) — the main artifact for "what exactly happened on this run."

A single slide or input file failing (corrupt PDF, a render crash) is logged and skipped — it's
marked `FAILED`/`needs review` in the report instead of losing the rest of the deck. Log files older
than 14 days are pruned automatically. Nothing here is ever uploaded; it's local disk only.

## Share it on GitHub

The repo is ready to push as-is — generated artifacts (`node_modules/`, `assets/`, `output/`,
`logs/`, decks) are ignored, and `npm install && npm run assets` rebuilds everything a clone needs.

```bash
git init
git add -A
git commit -m "Slidecraft: HTML/PDF/PPTX/images -> editable PowerPoint"
# with the GitHub CLI (easiest):
gh repo create slidecraft --public --source . --push
# or create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/slidecraft.git
git push -u origin main
```

## Host it online (optional)

Slidecraft is **local-first** — running it on your own machine is the primary, fastest, and most
capable mode (PowerPoint verification, PPTX ingest, and PDF export need Windows + Office). But the
web UI also runs on a free cloud host using the included `Dockerfile`:

1. Push the repo to GitHub (above).
2. Create a free account at [render.com](https://render.com) (or railway.app / fly.io).
3. **New → Web Service → connect your GitHub repo.** Render auto-detects the `Dockerfile`;
   no configuration needed (it injects `PORT`, and the image sets `HOST=0.0.0.0`).
4. Deploy. Your converter is live at `https://<name>.onrender.com`.

What changes in the cloud (Linux, no PowerPoint) — **the UI detects this automatically**
(via `/api/capabilities`): it shows a "☁ cloud mode" badge, drops PPTX from the file
picker, hides the PDF button, and locks quick mode on. So the hosted app never offers a
feature it can't deliver.

- Conversions run in **quick mode** automatically (Layer-1 validation still runs; the
  PowerPoint pixel-diff verification is skipped).
- **PPTX input** and **PDF download** are unavailable (both drive PowerPoint via COM) — the
  server returns a clean "unavailable on this host" message rather than erroring.
- HTML / PDF / image → editable PPTX all work: Chromium, Python (PyMuPDF/OpenCV), and OCR are
  baked into the image, and all assets are vendored at build time.
- Free tiers sleep after idle and give ~512 MB RAM — fine for casual decks; very dense
  30-slide conversions may need a paid tier's memory.

No Docker knowledge is required — the `Dockerfile` is just the recipe the host builds
automatically when you connect the repo.
