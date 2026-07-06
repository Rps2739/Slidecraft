# HTML -> Editable PPTX Converter — Handoff Brief

> **STATUS (2026-07-05): v2 built and verified.** The browser-backed converter + offline web UI
> described in `README.md` is complete. It converts real Tailwind/flexbox/grid HTML (not just
> absolutely-positioned) into native editable pptx, with a 3-layer correctness system verified
> against PowerPoint. Validated on 61 real reference slides: 59 clean, 2 flagged-for-review, 100%
> native text coverage, 0 external network calls. See `README.md` for usage; `src/` for the pipeline
> (normalize → render → extract → map → emit → validate → verify). The notes below are the original
> v1 brief, kept for history.

## What this project is
A local tool that converts hand-authored HTML slides into a NATIVE, fully editable
.pptx (real text boxes, shapes, and tables — never screenshots/images of slides).
Built for national-level case-competition decks where the deck MUST be editable in
PowerPoint and must look bespoke (not template-generic).

## Core decisions already made (don't re-litigate)
- Output must be EDITABLE: content (text, tables) is always native pptx objects.
  Only purely-decorative exotic effects may ever fall back to an image.
- "Guaranteed clean" comes from a VALIDATOR, not from fixed layouts. Each slide is
  bespoke; a checker flags problems before export. This preserves creativity.
- Input is disciplined HTML: fixed 1280x720 canvas, every element absolutely
  positioned (left/top/width/height in px), inline styles. data-shape="roundrect"
  or "chevron" marks special shapes. <table> becomes a native pptx table.
- HTML is authored per-slide as files in slides/. build.js converts the whole
  folder into one deck.pptx + a per-slide validation report. Fix one file to fix
  one slide (keeps token/iteration cost low; no whole-deck regeneration).

## Files
- build.js       : multi-slide builder (slides/*.html -> deck.pptx + validation report)
- convert2.js    : single-slide converter (tables, chevrons, rounded cards, validator)
- convert.js     : minimal first version (kept for reference)
- slides/        : per-slide HTML source (01-title.html, 02-decision.html)
- package.json   : deps -> pptxgenjs, node-html-parser

## Run
    npm install
    node build.js          # -> deck.pptx + validation report

## What works
- Native editable text, rectangles, rounded rectangles, chevron navs, native TABLES.
- Zero flattened images (verified in slide XML: <a:tbl> present, ppt/media empty).
- Validator flags text-on-text overlap and off-canvas elements per slide.

## What's NOT done yet (the real next work)
1. TEXT-MEASUREMENT VALIDATION (highest priority): current validator catches overlap
   and off-canvas, but not "text overflows its box." Needs a headless browser
   (Puppeteer) to measure rendered text — only possible on a local machine, which is
   why we moved here. Add Puppeteer, load each slide HTML, use getBoundingClientRect
   + range measurement to detect overflow and lock line breaks.
2. Bespoke decorative elements: connector arrows, Porter's-5-Forces pentagon, curved
   "5 whys" text spokes. Decide per element: native shape, or ship as image.
3. Font embedding / exact font matching so PowerPoint rendering matches the HTML.
4. Optional: browser-backed layout so flexbox/grid HTML also works (currently input
   must be absolutely positioned).

## Working style
Claude authors the slide HTML into slides/, runs build.js, reads the validation
report, self-corrects the HTML, then hands over the editable deck. User brings the
content/brief and the judgment on whether it's competition-winning.
