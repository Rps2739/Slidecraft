// ui/app.js — Slidecraft front-end. Vanilla JS, fully offline, no external deps.

const $ = (id) => document.getElementById(id);
let items = []; // { name, content, badge }
let caps = { powerpoint: true, features: { verify: true, pptxInput: true, pdfExport: true } };

const isMedia = (n) => /\.(pdf|pptx?|png|jpe?g|webp|bmp|tiff?)$/i.test(n);

// Detect what this deployment supports (a cloud/Linux host has no PowerPoint) and adapt
// the UI: show a "cloud mode" note, drop PPTX from accepted inputs, hide the PDF button.
fetch("/api/capabilities").then((r) => r.json()).then((c) => {
  caps = c;
  if (!c.powerpoint) {
    $("cloudnote").classList.add("on");
    // PPTX input needs PowerPoint — remove it from the file picker + hints
    const fi = $("file");
    if (fi) fi.setAttribute("accept", ".html,.htm,.txt,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff");
    const fmt = document.querySelector("#drop .fmt");
    if (fmt) fmt.textContent = "html · txt · pdf · png · jpg";
    // Quick mode is the only mode without PowerPoint verification — lock it on
    const fast = $("fast");
    if (fast) { fast.checked = true; fast.disabled = true; }
  }
}).catch(() => {});

// Detect slide boundaries the same way the server does (doctype -> <html> -> slide-container).
function splitSlides(t) {
  t = (t || "").trim();
  if (!t) return [];
  if ((t.match(/<!DOCTYPE html>/gi) || []).length > 1) return t.split(/(?=<!DOCTYPE html>)/i).map((s) => s.trim()).filter(Boolean);
  if ((t.match(/<html[\s>]/gi) || []).length > 1) return t.split(/(?=<html[\s>])/i).map((s) => s.trim()).filter(Boolean);
  if ((t.match(/class\s*=\s*["'][^"']*\bslide-container\b/gi) || []).length > 1)
    return t.split(/(?=<div[^>]*class\s*=\s*["'][^"']*\bslide-container\b)/i).map((s) => s.trim()).filter(Boolean);
  return [t];
}
const countSlides = (txt) => Math.max(1, splitSlides(txt).length);

function toast(msg, good = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("good", good);
  el.classList.add("on");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("on"), 5200);
}

/* ---------- delight: 3D tilt on the hero canvas ---------- */
const cv = $("canvas");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (cv && !reduceMotion) {
  let tiltRaf = 0;
  cv.addEventListener("mousemove", (e) => {
    if (cv.classList.contains("busy") || tiltRaf) return;
    tiltRaf = requestAnimationFrame(() => {
      tiltRaf = 0;
      const r = cv.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -5;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * 7;
      cv.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    });
  });
  cv.addEventListener("mouseleave", () => { cv.style.transform = ""; });
}

/* confetti burst when a deck verifies clean */
function confetti() {
  if (reduceMotion) return;
  const colors = ["#e8543f", "#7c5cff", "#3ecf8e", "#f2b84b", "#ff8a5c", "#5eead4"];
  for (let i = 0; i < 42; i++) {
    const c = document.createElement("div");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 1.3 + Math.random() * 1.4 + "s";
    c.style.animationDelay = Math.random() * 0.5 + "s";
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3400);
  }
}

/* animated count-up for the summary chips */
function countUp(el, n) {
  if (reduceMotion || n <= 1) { el.textContent = el.textContent.replace("#", n); return; }
  let cur = 0;
  const step = Math.max(1, Math.round(n / 24));
  const base = el.textContent;
  const iv = setInterval(() => {
    cur = Math.min(n, cur + step);
    el.textContent = base.replace("#", cur);
    if (cur >= n) clearInterval(iv);
  }, 28);
}

/* ---------- tabs ---------- */
function pickTab(which) {
  $("tabUpload").classList.toggle("on", which === "up");
  $("tabPaste").classList.toggle("on", which === "paste");
  $("paneUpload").classList.toggle("on", which === "up");
  $("panePaste").classList.toggle("on", which === "paste");
}
$("tabUpload").addEventListener("click", () => pickTab("up"));
$("tabPaste").addEventListener("click", () => pickTab("paste"));

/* ---------- slide tray ---------- */
function renderFiles() {
  const ul = $("files");
  ul.innerHTML = "";
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="cnt">${it.badge}</span>
      <span class="nm" title="${it.name}">${it.name}</span>
      <button data-up="${i}" ${i === 0 ? "disabled" : ""} title="Move up">▲</button>
      <button data-down="${i}" ${i === items.length - 1 ? "disabled" : ""} title="Move down">▼</button>
      <button data-del="${i}" title="Remove">✕</button>`;
    ul.appendChild(li);
  });
  $("convert").disabled = items.length === 0;
}

function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /\.(html?|txt|pdf|pptx?|png|jpe?g|webp|bmp|tiff?)$/i.test(f.name));
  if (!files.length) { toast("Unsupported file type — use HTML, TXT, PDF, PPTX or images."); return; }
  let pending = files.length;
  files.forEach((f) => {
    const reader = new FileReader();
    const media = isMedia(f.name);
    const badge = /\.pdf$/i.test(f.name) ? "PDF" : /\.pptx?$/i.test(f.name) ? "PPT" : "IMG";
    reader.onload = () => {
      items.push({
        name: f.name,
        content: reader.result, // data-URL for media, text for html
        badge: media ? badge : countSlides(reader.result) + " ▦",
      });
      if (--pending === 0) renderFiles();
    };
    if (media) reader.readAsDataURL(f);
    else reader.readAsText(f);
  });
}

// browse + drag/drop on both the rail dropzone and the big slide canvas
const dropTargets = [$("drop"), $("canvas")];
$("drop").addEventListener("click", () => $("file").click());
$("canvas").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
dropTargets.forEach((el) => {
  ["dragover", "dragenter"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove("over"); }));
  el.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
});

/* ---------- paste / HTML editor ----------
   The editor KEEPS what you paste visible so you can read and edit it. Two synced views:
   the rail textarea (#paste) and a big modal editor (#pasteBig). "Add to tray" moves the
   editor content in as slides. */
const pasteEl = $("paste");
const pasteBig = $("pasteBig");
const looksLikeSlideHtml = (t) => !!t && /<!DOCTYPE html>|<html[\s>]|slide-container|<body[\s>]|<div[\s>]/i.test(t);
let pasteSeq = 0;

// title of a slide doc (for the detected-slides list): <title>, else first <h1>, else "Slide N"
function slideTitleOf(html, i) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return t[1].replace(/<[^>]+>/g, "").trim().slice(0, 60);
  const h = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h && h[1].trim()) return h[1].replace(/<[^>]+>/g, "").trim().slice(0, 60);
  return `Slide ${i + 1}`;
}

// reflect current editor content everywhere: count, detected-slides list, button state
function refreshEditor(val) {
  const docs = val.trim() ? splitSlides(val) : [];
  const n = docs.length;
  const label = n ? `${n} slide${n > 1 ? "s" : ""} detected` : "no slides yet";
  ["pasteCount", "pasteCountBig"].forEach((id) => {
    const el = $(id); if (!el) return;
    el.textContent = label;
    el.classList.toggle("has", n > 0);
  });
  ["addPaste", "addPasteBig"].forEach((id) => { const b = $(id); if (b) b.disabled = n === 0; });
  const rows = docs.map((d, i) =>
    `<li><span class="idx">${String(i + 1).padStart(2, "0")}</span><span class="ttl">${slideTitleOf(d, i).replace(/</g, "&lt;")}</span></li>`).join("");
  ["slidelist", "slidelistBig"].forEach((id) => { const ul = $(id); if (ul) ul.innerHTML = rows; });
}
// keep the two textareas in sync
function setEditor(val, from) {
  if (from !== "small") pasteEl.value = val;
  if (from !== "big") pasteBig.value = val;
  refreshEditor(val);
}
pasteEl.addEventListener("input", () => setEditor(pasteEl.value, "small"));
pasteBig.addEventListener("input", () => setEditor(pasteBig.value, "big"));

function addFromEditor() {
  const content = pasteEl.value.trim();
  if (!content) return;
  const docs = splitSlides(content);
  pasteSeq++;
  items.push({ name: `pasted-${pasteSeq}.html`, content: docs.join("\n\n"), badge: docs.length + " ▦" });
  renderFiles();
  setEditor("", null); // clear now that they're safely in the tray
  toast(`Added ${docs.length} slide${docs.length > 1 ? "s" : ""} to the tray`, true);
}
$("addPaste").addEventListener("click", addFromEditor);
$("addPasteBig").addEventListener("click", () => { addFromEditor(); closeEditor(); });
$("clearPaste").addEventListener("click", () => { setEditor("", null); pasteEl.focus(); });
$("clearPasteBig").addEventListener("click", () => { setEditor("", null); pasteBig.focus(); });

/* fullscreen editor modal */
function openEditor() {
  pasteBig.value = pasteEl.value;
  refreshEditor(pasteBig.value);
  $("editorModal").classList.add("on");
  $("editorModal").setAttribute("aria-hidden", "false");
  setTimeout(() => pasteBig.focus(), 30);
}
function closeEditor() {
  $("editorModal").classList.remove("on");
  $("editorModal").setAttribute("aria-hidden", "true");
}
$("expandPaste").addEventListener("click", openEditor);
$("closeEditor").addEventListener("click", closeEditor);
$("editorModal").addEventListener("click", (e) => { if (e.target === $("editorModal")) closeEditor(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("editorModal").classList.contains("on")) closeEditor(); });

// paste ANYWHERE on the page drops the HTML into the editor (visible + editable) and
// switches to the Paste tab — it does NOT silently add, so you always see it first.
window.addEventListener("paste", (e) => {
  const tgt = e.target;
  if (tgt === pasteEl || tgt === pasteBig || /^(INPUT|TEXTAREA)$/.test(tgt && tgt.tagName)) return;
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!looksLikeSlideHtml(text)) return;
  e.preventDefault();
  pickTab("paste");
  const joined = pasteEl.value.trim() ? pasteEl.value.replace(/\s*$/, "") + "\n\n" + text : text;
  setEditor(joined, null);
  pasteEl.focus();
  toast("Pasted into the editor — review, then Add to tray", true);
});
refreshEditor("");

/* ---------- tray actions ---------- */
$("files").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.del != null) items.splice(+b.dataset.del, 1);
  else if (b.dataset.up != null) { const i = +b.dataset.up; [items[i - 1], items[i]] = [items[i], items[i - 1]]; }
  else if (b.dataset.down != null) { const i = +b.dataset.down; [items[i + 1], items[i]] = [items[i], items[i + 1]]; }
  renderFiles();
});

/* ---------- convert (streams progress over SSE) ---------- */

// Map a pipeline progress event to a target bar fraction [0,1] + a human label.
// Bands: read/render 0-.62, write .62, verify .62-.97, refine .95-.99, done 1.
function progressTarget(evt) {
  switch (evt.phase) {
    case "ingest":      return { frac: 0.02, label: "Reading input…", indet: true };
    case "start":       return { frac: 0.05, label: `Rendering ${evt.total} slide${evt.total > 1 ? "s" : ""}…` };
    case "slide":       return { frac: 0.05 + 0.57 * (evt.done / Math.max(evt.total, 1)), label: `Rendering slide ${evt.done} / ${evt.total}` };
    case "write":       return { frac: 0.63, label: "Writing deck…" };
    case "verify":      return { frac: 0.96, label: "Verifying with PowerPoint…", slow: true };
    case "refine-load": return { frac: 0.955, label: "Refining drifted slides…", slow: true };
    case "refine":      return evt.total ? { frac: 0.955 + 0.035 * (evt.done / evt.total), label: `Refining slide ${evt.done} / ${evt.total}` } : { frac: 0.955, label: "Refining drifted slides…", slow: true };
    default:            return null;
  }
}

/* ---------- live per-slide preview while converting ---------- */
// A grid of placeholder cards appears the moment slide count is known; each card fills
// in with the slide's actual render + status as the pipeline finishes it.
function liveGridStart(total) {
  $("empty").style.display = "none";
  $("results").classList.add("on");
  $("summary").innerHTML = `<span class="chip">converting ${total} slide${total > 1 ? "s" : ""}…</span>`;
  $("filters").innerHTML = "";
  $("dlwrap").innerHTML = "";
  const grid = $("grid");
  grid.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const card = document.createElement("div");
    card.className = "slide";
    card.id = `live-${i + 1}`;
    card.style.animationDelay = Math.min(i * 30, 400) + "ms";
    card.innerHTML =
      `<div class="noimg q">queued</div>` +
      `<div class="strip"><span class="no">${String(i + 1).padStart(2, "0")}</span>` +
      `<span class="nm">slide ${i + 1}</span>` +
      `<span class="tag wait">waiting</span></div>`;
    grid.appendChild(card);
  }
  const first = $("live-1");
  if (first) first.querySelector(".tag").outerHTML = `<span class="tag live">rendering…</span>`;
}

function liveSlideUpdate(evt, refining) {
  const card = $(`live-${evt.done}`);
  if (!card) return;
  // swap the placeholder for the real render of this slide (now on disk)
  const ph = card.querySelector(".noimg");
  if (ph) {
    const img = document.createElement("img");
    img.src = `/work-thumb/${evt.done}?t=${Date.now()}`;
    img.alt = `slide ${evt.done}`;
    img.decoding = "async";
    img.onerror = () => { img.replaceWith(Object.assign(document.createElement("div"), { className: "noimg", textContent: "no preview" })); };
    ph.replaceWith(img);
  }
  if (evt.title) card.querySelector(".nm").textContent = evt.title;
  const tag = card.querySelector(".tag");
  tag.className = "tag " + (evt.failed ? "rev" : refining ? "live" : evt.ok === false ? "rev" : "ok");
  tag.textContent = evt.failed ? "✖ failed" : refining ? "polishing…" : evt.ok === false ? "⚠ checking" : "✓ done";
  // move the "rendering…" pulse to the next queued card
  const next = $(`live-${evt.done + 1}`);
  if (next) {
    const nt = next.querySelector(".tag");
    if (nt && nt.classList.contains("wait")) { nt.className = "tag live"; nt.textContent = refining ? "polishing…" : "rendering…"; }
  }
}

function liveMarkAll(text) {
  $("grid").querySelectorAll(".tag.live, .tag.wait").forEach((t) => { t.className = "tag live"; t.textContent = text; });
}

$("convert").addEventListener("click", async () => {
  const btn = $("convert");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp; Converting`;
  $("canvas").classList.add("busy");
  $("progress").classList.add("on");
  $("pbar").classList.add("indet");
  $("pmsg").textContent = "Starting…";
  $("ptime").textContent = "0s";

  const bar = $("pbar").querySelector("i");
  const t0 = Date.now();
  let target = 0.02, disp = 0, slow = false;

  // one render loop: eases the shown fraction toward target, ticks %, elapsed + ETA
  const tick = setInterval(() => {
    const k = slow ? 0.045 : 0.28;                 // verify creeps; other phases snap
    disp += (target - disp) * k;
    if (target - disp < 0.002) disp = target;
    bar.style.width = (disp * 100).toFixed(1) + "%";
    $("ppct").textContent = Math.round(disp * 100) + "%";
    const elapsed = (Date.now() - t0) / 1000;
    let s = Math.round(elapsed) + "s";
    if (disp > 0.06 && disp < 0.999) {
      const eta = Math.round(elapsed * (1 - disp) / disp);
      if (eta > 0) s += ` · ~${eta}s left`;
    }
    $("ptime").textContent = s;
    const cap = $("caption");
    if (cap) cap.textContent = "converting — " + $("pmsg").textContent.toLowerCase();
  }, 150);

  try {
    const resp = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: items.map((i) => ({ name: i.name, content: i.content })),
        fast: $("fast").checked,
        autoFix: $("autofix").checked,
        overlayOnly: $("overlay").checked,
      }),
    });
    if (!resp.ok && !resp.body) {
      let err = "conversion failed";
      try { err = (await resp.json()).error || err; } catch (_) {}
      throw new Error(err);
    }

    // parse the SSE stream: lines of `data: {json}\n\n`
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", done = null, failed = null;
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let msg; try { msg = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (msg.type === "progress") {
          const t = progressTarget(msg);
          if (t) {
            $("pbar").classList.toggle("indet", !!t.indet);
            if (!t.indet) target = Math.max(target, t.frac); // never go backwards
            slow = !!t.slow;
            $("pmsg").textContent = t.label;
          }
          // drive the live per-slide grid
          if (msg.phase === "start") liveGridStart(msg.total);
          else if (msg.phase === "slide") liveSlideUpdate(msg, false);
          else if (msg.phase === "refine" && msg.done) liveSlideUpdate(msg, true);
          else if (msg.phase === "verify") liveMarkAll("verifying…");
          else if (msg.phase === "refine-load") liveMarkAll("polishing…");
        } else if (msg.type === "done") {
          done = msg;
        } else if (msg.type === "error") {
          failed = msg.error || "conversion failed";
        }
      }
    }
    if (failed) throw new Error(failed);
    if (!done) throw new Error("conversion ended unexpectedly");

    // snap the bar to 100% before revealing results
    slow = false; target = 1;
    $("pbar").classList.remove("indet");
    bar.style.width = "100%";
    $("ppct").textContent = "100%";
    $("pmsg").textContent = "Done";
    $("ptime").textContent = "took " + Math.round((Date.now() - t0) / 1000) + "s";
    showResults(done);
    const bad = done.reports.filter((r) => r.needsReview).length;
    if (!bad) { confetti(); toast(`All ${done.count} slides verified clean ✓`, true); }
  } catch (e) {
    toast("Conversion failed: " + e.message);
  } finally {
    clearInterval(tick);
    $("canvas").classList.remove("busy");
    const cap = $("caption"); if (cap) cap.textContent = "slide 1 of ∞ — waiting for input";
    setTimeout(() => { $("progress").classList.remove("on"); $("pbar").querySelector("i").style.width = "0%"; }, 900);
    btn.disabled = items.length === 0;
    btn.textContent = "Convert deck";
  }
});

function showResults(data) {
  $("empty").style.display = "none";
  $("results").classList.add("on");
  const reviews = data.reports.filter((r) => r.needsReview).length;
  $("summary").innerHTML =
    `<span class="chip" data-count><span class="n"># slides</span></span>` +
    `<span class="chip ok" style="animation-delay:.08s" data-count-ok><span class="n"># verified</span></span>` +
    (reviews ? `<span class="chip rev" style="animation-delay:.16s"># to review</span>` : `<span class="chip ok" style="animation-delay:.16s">all clear ✓</span>`) +
    (data.autoFixed ? `<span class="chip fix" style="animation-delay:.24s">${data.autoFixed} auto-fixed</span>` : "");
  countUp($("summary").querySelector("[data-count] .n"), data.count);
  countUp($("summary").querySelector("[data-count-ok] .n"), data.count - reviews);
  const revChip = $("summary").querySelector(".chip.rev");
  if (revChip) revChip.textContent = `${reviews} to review`;

  // filter chips: All / OK / Review (review only shown when relevant)
  const filters = $("filters");
  filters.innerHTML =
    `<span class="chip filter active" data-f="all">All</span>` +
    `<span class="chip filter" data-f="ok">OK</span>` +
    (reviews ? `<span class="chip filter" data-f="rev">Review</span>` : "");
  filters.querySelectorAll(".filter").forEach((f) => f.addEventListener("click", () => {
    filters.querySelectorAll(".filter").forEach((x) => x.classList.toggle("active", x === f));
    const mode = f.dataset.f;
    $("grid").querySelectorAll(".slide").forEach((card) => {
      const isRev = card.dataset.rev === "1";
      card.classList.toggle("hide", mode === "ok" ? isRev : mode === "rev" ? !isRev : false);
    });
  }));

  const pdfUrl = data.download.replace("/download/", "/download-pdf/");
  $("dlwrap").innerHTML =
    `<a href="${data.download}" download><button class="btn dl pptx">⤓ PPTX</button></a>` +
    // PDF export needs PowerPoint — only offer it where that's available
    (caps.features && caps.features.pdfExport
      ? `<a href="${pdfUrl}" download><button class="btn dl pdf">⤓ PDF</button></a>` : "");

  const grid = $("grid");
  grid.innerHTML = "";
  data.reports.forEach((r, i) => {
    const rev = r.needsReview;
    const diff = r.diffPct != null ? ` ${r.diffPct}%` : "";
    // diff meter: scale so the tolerance lands at ~75% of the bar
    const tol = r.diffTolerance || 8;
    const meterPct = r.diffPct != null ? Math.min(100, (r.diffPct / tol) * 75) : 0;
    const card = document.createElement("div");
    card.className = "slide";
    card.dataset.rev = rev ? "1" : "0";
    card.style.animationDelay = Math.min(i * 45, 560) + "ms";
    card.innerHTML =
      (data.thumbnails[i]
        ? `<img src="${data.thumbnails[i]}" alt="slide ${i + 1}" loading="lazy" />`
        : `<div class="noimg">no preview</div>`) +
      (r.diffPct != null ? `<div class="meter" title="visual drift ${r.diffPct}% (tolerance ${tol}%)"><i style="width:${meterPct.toFixed(0)}%"></i></div>` : "") +
      `<div class="strip"><span class="no">${String(i + 1).padStart(2, "0")}</span>` +
      `<span class="nm" title="${r.title || r.name}">${r.title || r.name}</span>` +
      `<span class="tag ${rev ? "rev" : "ok"}">${rev ? "⚠ review" : "✓ ok"}${diff}</span></div>` +
      (rev && r.issues && r.issues.length ? `<div class="issues">${r.issues.join(" · ")}</div>` : "");
    grid.appendChild(card);
  });
}
