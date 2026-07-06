// scripts/vendor_assets.js — copy open-source assets from installed npm packages into
// assets/ so the app runs 100% offline. Run once after `npm install`:  npm run assets
//
// Vendors: Font Awesome CSS + webfonts, Inter/Montserrat/Roboto woff2 (+ a local
// @font-face css), and generates the Tailwind v3 CSS (with a first content scan).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const A = path.join(ROOT, "assets");
const mk = (p) => fs.mkdirSync(p, { recursive: true });

mk(path.join(A, "fontawesome", "webfonts"));
mk(path.join(A, "fonts"));
mk(path.join(A, "tailwind"));
mk(path.join(A, "charts"));

// --- Charting libraries (ECharts / Chart.js) ---
// AI slide generators (Genspark, etc.) draw charts with these from a CDN; vendoring them
// lets charts render in the network-sealed browser so they can be captured.
const chartLibs = [
  ["node_modules/echarts/dist/echarts.min.js", "echarts.min.js"],
  ["node_modules/chart.js/dist/chart.umd.js", "chart.min.js"],
];
for (const [src, dst] of chartLibs) {
  const p = path.join(ROOT, src);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(A, "charts", dst));
  else console.warn("chart lib missing (run npm install):", src);
}

// --- Font Awesome ---
const faCssSrc = path.join(ROOT, "node_modules/@fortawesome/fontawesome-free/css/all.min.css");
let faCss = fs.readFileSync(faCssSrc, "utf8").replace(/\.\.\/webfonts\//g, "/assets/fontawesome/webfonts/");
fs.writeFileSync(path.join(A, "fontawesome", "all.min.css"), faCss);
const faWf = path.join(ROOT, "node_modules/@fortawesome/fontawesome-free/webfonts");
fs.readdirSync(faWf).filter((f) => f.endsWith(".woff2")).forEach((f) =>
  fs.copyFileSync(path.join(faWf, f), path.join(A, "fontawesome", "webfonts", f)));

// --- Fonts (Inter / Montserrat / Roboto) ---
const fams = { Inter: "inter", Montserrat: "montserrat", Roboto: "roboto" };
const weights = [300, 400, 500, 600, 700, 800];
const faces = [];
for (const [disp, slug] of Object.entries(fams)) {
  for (const w of weights) {
    const src = path.join(ROOT, `node_modules/@fontsource/${slug}/files/${slug}-latin-${w}-normal.woff2`);
    if (!fs.existsSync(src)) continue;
    const file = `${slug}-latin-${w}-normal.woff2`;
    fs.copyFileSync(src, path.join(A, "fonts", file));
    faces.push(`@font-face{font-family:'${disp}';font-style:normal;font-weight:${w};font-display:swap;src:url('/assets/fonts/${file}') format('woff2');}`);
  }
}
fs.writeFileSync(path.join(A, "fonts", "fonts.css"), faces.join("\n") + "\n");

// --- Tailwind v3 (entry + config + first build) ---
fs.writeFileSync(path.join(A, "tailwind", "entry.css"), "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
const cfg = `module.exports = {
  content: ["HTML references/**/*.html", "HTML references/**/*.txt", "slides/**/*.html", ".ui-input/**/*", ".tw-input/**/*"],
  theme: { extend: {} },
  corePlugins: { preflight: false },
};\n`;
fs.writeFileSync(path.join(A, "tailwind", "tailwind.config.js"), cfg);
try {
  // invoke the CLI's JS directly with node (portable across OSes; avoids .cmd spawn quirks)
  execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "tailwindcss", "lib", "cli.js"),
     "-c", "assets/tailwind/tailwind.config.js", "-i", "assets/tailwind/entry.css",
     "-o", "assets/tailwind/tailwind.generated.css", "--minify"],
    { cwd: ROOT, stdio: "inherit" }
  );
} catch (e) {
  console.warn("Tailwind build step failed (run it manually if needed):", e.message);
}

// --- OCR language data (Tesseract) for offline image/scanned-PDF conversion ---
const tessdir = path.join(A, "tessdata");
mk(tessdir);
const engPath = path.join(tessdir, "eng.traineddata");
if (!fs.existsSync(engPath)) {
  const https = require("https");
  const url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";
  console.log("Downloading OCR language data (one-time)...");
  try {
    const buf = require("child_process").execFileSync(process.execPath, ["-e",
      `const https=require('https');https.get(${JSON.stringify(url)},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>process.stdout.write(Buffer.concat(c)))})`
    ], { maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(engPath, buf);
    console.log("OCR data vendored.");
  } catch (e) {
    console.warn("Could not fetch OCR data (image/scanned OCR will need network on first use):", e.message);
  }
}

console.log("Assets vendored into assets/ — the app now runs fully offline.");
