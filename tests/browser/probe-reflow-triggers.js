/*
 * Which changes to the PDF viewer's layout can a content script actually
 * observe? The viewer is a closed, out-of-process frame, so this cannot be
 * reasoned about — it has to be measured.
 *
 * For each action we (a) check whether the page rectangle moved, and (b) list
 * every event the top-level document received.
 *
 * Run: CHROME_BIN=... node tests/browser/probe-reflow-triggers.js
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { connect } = require("./mini-cdp.js");
const { detectPageInsets } = require("../../scripts/core.js");

const EXT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "findings", "triggers");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePdf() {
  const objs = ["<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>", null, null, null, null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  [3, 5].forEach((p, i) => {
    objs[p - 1] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${p + 1} 0 R` +
      `/Resources<</Font<</F1 7 0 R>>>>>>`;
    const s = `BT /F1 28 Tf 60 720 Td (Page ${i + 1}) Tj ET\n` +
      `BT /F1 12 Tf 60 680 Td (Black ink on a white page.) Tj ET\n` +
      `0.85 0.85 0.85 rg 60 460 490 170 re f`;
    objs[p] = `<</Length ${s.length}>>\nstream\n${s}\nendstream`;
  });
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((b, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => { pdf += `${String(o).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function decodePng(file) {
  const raw = `${file}.rgba`;
  const [w, h] = execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert("RGBA")
open(${JSON.stringify(raw)}, "wb").write(im.tobytes())
print(im.size[0], im.size[1])
`], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  return { data: new Uint8ClampedArray(fs.readFileSync(raw)), width: w, height: h };
}

const LOGGER = `
  (() => {
    window.__evt = [];
    const log = (name) => window.__evt.push(name);
    ['resize','scroll','message','keydown','click','wheel','visibilitychange',
     'focus','blur','load','pointerdown','fullscreenchange','hashchange','popstate',
     'pageshow','transitionend','animationend']
      .forEach((n) => window.addEventListener(n, () => log('window:' + n), true));
    document.addEventListener('scroll', () => log('document:scroll'), true);

    try {
      new ResizeObserver(() => log('ResizeObserver:body')).observe(document.body);
      new ResizeObserver(() => log('ResizeObserver:html')).observe(document.documentElement);
    } catch (e) { log('ResizeObserver:unavailable'); }

    try {
      new MutationObserver(() => log('MutationObserver:body'))
        .observe(document.body, { childList: true, subtree: true, attributes: true });
    } catch (e) { log('MutationObserver:unavailable'); }

    try {
      matchMedia('(resolution: 1dppx)').addEventListener('change', () => log('mq:resolution'));
    } catch (e) { /* older */ }

    window.__snap = () => ({
      innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
      href: location.href, hash: location.hash, title: document.title,
      bodyRect: (() => { const r = document.body.getBoundingClientRect();
                         return [r.width, r.height]; })(),
      historyLength: history.length,
    });
    return true;
  })()
`;

async function main() {
  const chromeBin = process.env.CHROME_BIN ||
    path.resolve(EXT, "..", "chrome-linux64", "chrome");
  if (!fs.existsSync(chromeBin)) { console.log("set CHROME_BIN"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const pdf = makePdf();
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length });
    res.end(pdf);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-trig-"));
  const dp = 9200 + Math.floor(Math.random() * 200);
  const child = spawn(chromeBin, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--window-size=1280,900",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${dp}`,
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const results = [];

  try {
    await sleep(3000);
    const cdp = await connect(dp);
    const { targetId } = await cdp.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/doc.pdf`,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(3200);

    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate",
        { expression: expr, returnByValue: true }, sessionId);
      return r.result?.value;
    };

    const measure = async (label) => {
      // remove our layers so the capture shows the viewer as-is
      await ev(`['darkDiv','tintDiv','pdfDarkModeDock']
        .forEach(id => document.getElementById(id)?.remove()); true`);
      await sleep(400);
      const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const f = path.join(OUT, `${label}.png`);
      fs.writeFileSync(f, Buffer.from(r.data, "base64"));
      const img = decodePng(f);
      const insets = detectPageInsets(img.data, img.width, img.height);
      return insets && { top: insets.top, right: insets.right, left: insets.left,
                         bottom: insets.bottom, confident: insets.confident };
    };

    const click = async (x, y) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent",
          { type, x, y, button: "left", clickCount: 1 }, sessionId);
      }
    };

    await ev(LOGGER);
    const before0 = await measure("00-initial");
    results.push({ action: "initial load", rect: before0, events: [] });

    const run = async (label, action, coords) => {
      await ev(`window.__evt = []; true`);
      const rectBefore = await measure(`${label}-before`);
      await action();
      await sleep(2500);
      const events = await ev(`Array.from(new Set(window.__evt))`);
      const metrics = await ev(`window.__snap()`);
      const rectAfter = await measure(`${label}-after`);

      const moved = !!(rectBefore && rectAfter) && (
        rectBefore.left !== rectAfter.left ||
        rectBefore.right !== rectAfter.right ||
        rectBefore.top !== rectAfter.top);

      results.push({ action: label, coords, rectBefore, rectAfter, moved,
                     events: events || [], metrics });
    };

    // The viewer's own zoom-in button (from the 1280px-wide layout).
    await run("pdf-zoom-in-button", () => click(601, 28), "601,28");
    // The hamburger, which toggles the thumbnail sidebar.
    await run("pdf-sidebar-toggle", () => click(32, 28), "32,28");
    // A genuine window resize.
    await run("window-resize", () => cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId));
    // Browser-level zoom, which is what Ctrl+/- does.
    await run("browser-zoom-dpr", () => cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1000, height: 760, deviceScaleFactor: 1.5, mobile: false }, sessionId));

    cdp.close();
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
  }

  console.log("");
  for (const r of results) {
    if (!r.rectBefore) { console.log(`── ${r.action}: ${JSON.stringify(r.rect)}\n`); continue; }
    console.log(`── ${r.action}${r.coords ? ` (click ${r.coords})` : ""}`);
    console.log(`   rect before  ${JSON.stringify(r.rectBefore)}`);
    console.log(`   rect after   ${JSON.stringify(r.rectAfter)}`);
    console.log(`   layout moved ${r.moved ? "YES" : "no"}`);
    console.log(`   events seen  ${r.events.length ? r.events.join(", ") : "(NONE)"}`);
    console.log(`   metrics      ${JSON.stringify(r.metrics)}`);
    console.log(`   => ${r.moved ? (r.events.length ? "observable" : "SILENT - no event to hook") : "no change"}`);
    console.log("");
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`details in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
