/*
 * Does option A actually work? Drives real Chrome, detects the page rectangle
 * from a screenshot, clips the overlay to it, and then VERIFIES BY OUTCOME:
 *
 *   - the toolbar strip must still match the untouched baseline (not inverted)
 *   - the sidebar must still match the baseline
 *   - the page centre must be inverted
 *
 * That is a stronger check than comparing against a hand-guessed rectangle.
 *
 * Run: CHROME_BIN=... node tests/browser/prototype-page-clip.js
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { connect } = require("./mini-cdp.js");
const { detectPageInsets } = require("../../scripts/core.js");

const EXT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "findings", "clip");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- fixtures */

function makePdf({ dark = false } = {}) {
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>",
    null, null, null, null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const fontId = 7;

  const body = (n) =>
    dark
      ? `0.08 0.08 0.10 rg 0 0 612 792 re f\n1 1 1 rg\n` +
        `BT /F1 28 Tf 60 700 Td (Dark slide ${n}) Tj ET\n` +
        `BT /F1 12 Tf 60 660 Td (Light text on a dark background.) Tj ET`
      : `BT /F1 28 Tf 60 720 Td (Page ${n} heading) Tj ET\n` +
        `BT /F1 12 Tf 60 680 Td (Body copy on a white page, black ink.) Tj ET\n` +
        `0.85 0.85 0.85 rg 60 460 490 170 re f\n` +
        `0 0 0 rg BT /F1 12 Tf 80 540 Td (A light grey figure box) Tj ET`;

  [3, 5].forEach((pageId, idx) => {
    const contentId = pageId + 1;
    objs[pageId - 1] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R` +
      `/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
    const stream = body(idx + 1);
    objs[contentId - 1] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((b, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => { pdf += `${String(o).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/* PNG -> raw RGBA, via Python since the sandbox has no npm. */
function decodePng(file) {
  const raw = `${file}.rgba`;
  const meta = execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert("RGBA")
open(${JSON.stringify(raw)}, "wb").write(im.tobytes())
print(im.size[0], im.size[1])
`], { encoding: "utf8" }).trim().split(/\s+/).map(Number);

  return { data: new Uint8ClampedArray(fs.readFileSync(raw)), width: meta[0], height: meta[1] };
}

function pixelAt(file, x, y) {
  return execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert("RGB")
print(*im.getpixel((${x}, ${y})))
`], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
}

const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const lum = (p) => (p[0] * 299 + p[1] * 587 + p[2] * 114) / 1000;

/* ------------------------------------------------------------------- main */

async function main() {
  const chromeBin = process.env.CHROME_BIN ||
    path.resolve(EXT, "..", "chrome-linux64", "chrome");
  if (!fs.existsSync(chromeBin)) {
    console.log("no Chrome binary; set CHROME_BIN");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const light = makePdf();
  const dark = makePdf({ dark: true });
  const server = http.createServer((req, res) => {
    const body = req.url.includes("dark") ? dark : light;
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-clip-"));
  const dp = 9500 + Math.floor(Math.random() * 200);
  const child = spawn(chromeBin, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${dp}`,
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const rows = [];

  try {
    await sleep(3000);
    const cdp = await connect(dp);
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    });

    const scenarios = [
      { name: "1280x900 light", url: "/doc.pdf", w: 1280, h: 900 },
      { name: "900x700 light", url: "/doc.pdf", w: 900, h: 700 },
      { name: "1600x1000 light", url: "/doc.pdf", w: 1600, h: 1000 },
      { name: "1280x900 DARK pdf", url: "/dark.pdf", w: 1280, h: 900 },
    ];

    for (const s of scenarios) {
      const { targetId } = await cdp.send("Target.createTarget", {
        url: `http://127.0.0.1:${port}${s.url}`,
      });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await sleep(3200);

      const ev = async (expr) => {
        const r = await cdp.send("Runtime.evaluate",
          { expression: expr, returnByValue: true }, sessionId);
        return r.result?.value;
      };
      const shoot = async (label) => {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        const f = path.join(OUT, `${label}.png`);
        fs.writeFileSync(f, Buffer.from(r.data, "base64"));
        return f;
      };

      const tag = s.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

      // 1. strip the extension's own layers so we measure the viewer as-is
      await ev(`['darkDiv','tintDiv','pdfDarkModeDock']
        .forEach(id => document.getElementById(id)?.remove()); true`);
      await sleep(500);
      const baseFile = await shoot(`${tag}-1-baseline`);

      // 2. detect
      const img = decodePng(baseFile);
      const t0 = process.hrtime.bigint();
      const insets = detectPageInsets(img.data, img.width, img.height);
      const detectMs = Number(process.hrtime.bigint() - t0) / 1e6;

      // 3. apply a clipped overlay using those insets
      if (insets && insets.confident) {
        await ev(`
          (() => {
            const d = document.createElement('div');
            d.id = 'darkDiv';
            d.setAttribute('style',
              'position:fixed;pointer-events:none;' +
              'top:${insets.top}px;right:${insets.right}px;' +
              'bottom:${insets.bottom}px;left:${insets.left}px;' +
              'background-color:#ffffffff;mix-blend-mode:difference;z-index:2147483646;');
            document.body.appendChild(d);
            return true;
          })()
        `);
      } else {
        await ev(`
          (() => {
            const d = document.createElement('div');
            d.id = 'darkDiv';
            d.setAttribute('style',
              'position:fixed;inset:0;pointer-events:none;' +
              'background-color:#ffffffff;mix-blend-mode:difference;z-index:2147483646;');
            document.body.appendChild(d);
            return true;
          })()
        `);
      }
      await sleep(600);
      const clipFile = await shoot(`${tag}-2-clipped`);

      // 4. verify by outcome
      const probes = {
        toolbar: [Math.floor(s.w / 2), 20],
        sidebarOrEdge: [12, Math.floor(s.h / 2)],
        pageCentre: [
          insets ? Math.floor(insets.left + (s.w - insets.left - insets.right) / 2) : Math.floor(s.w / 2),
          Math.floor(s.h * 0.35),
        ],
      };

      const before = {}, after = {};
      for (const [k, [x, y]] of Object.entries(probes)) {
        before[k] = pixelAt(baseFile, x, y);
        after[k] = pixelAt(clipFile, x, y);
      }

      // 5. re-measure with the overlay still on, using inverted:true
      const clipImg = decodePng(clipFile);
      const reInsets = detectPageInsets(clipImg.data, clipImg.width, clipImg.height, {
        inverted: true,
      });

      /*
       * 6. The no-flash re-measure. Reset to a FULL-viewport overlay (which is
       * just today's look for a moment, not a flash of white), capture, then
       * undo the inversion numerically — difference-with-white is exactly
       * 255 - channel — and run ordinary light-mode detection on the result.
       */
      await ev(`document.getElementById('darkDiv')?.remove(); true`);
      await ev(`
        (() => {
          const d = document.createElement('div');
          d.id = 'darkDiv';
          d.setAttribute('style',
            'position:fixed;inset:0;pointer-events:none;' +
            'background-color:#ffffffff;mix-blend-mode:difference;z-index:2147483646;');
          document.body.appendChild(d);
          return true;
        })()
      `);
      await sleep(600);
      const fullFile = await shoot(`${tag}-3-full-overlay`);
      const fullImg = decodePng(fullFile);
      const unInverted = new Uint8ClampedArray(fullImg.data.length);
      for (let i = 0; i < fullImg.data.length; i += 4) {
        unInverted[i] = 255 - fullImg.data[i];
        unInverted[i + 1] = 255 - fullImg.data[i + 1];
        unInverted[i + 2] = 255 - fullImg.data[i + 2];
        unInverted[i + 3] = 255;
      }
      const noFlashInsets = detectPageInsets(unInverted, fullImg.width, fullImg.height);

      rows.push({
        scenario: s.name,
        insets: insets && { ...insets },
        detectMs: Number(detectMs.toFixed(2)),
        toolbarPreserved: near(before.toolbar, after.toolbar),
        chromePreserved: near(before.sidebarOrEdge, after.sidebarOrEdge),
        pageInverted: Math.abs(lum(before.pageCentre) - lum(after.pageCentre)) > 80,
        before, after,
        reDetect: reInsets && {
          top: reInsets.top, right: reInsets.right,
          bottom: reInsets.bottom, left: reInsets.left, confident: reInsets.confident,
        },
        noFlash: noFlashInsets && {
          top: noFlashInsets.top, right: noFlashInsets.right,
          bottom: noFlashInsets.bottom, left: noFlashInsets.left,
          confident: noFlashInsets.confident,
        },
        noFlashMatches: !!(insets && noFlashInsets &&
          Math.abs(insets.top - noFlashInsets.top) <= 8 &&
          Math.abs(insets.left - noFlashInsets.left) <= 8 &&
          Math.abs(insets.right - noFlashInsets.right) <= 8),
      });

      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }

    cdp.close();
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
  }

  console.log("");
  for (const r of rows) {
    console.log(`── ${r.scenario}`);
    console.log(`   insets       ${r.insets ? `top=${r.insets.top} right=${r.insets.right} bottom=${r.insets.bottom} left=${r.insets.left} confident=${r.insets.confident}` : "none"}`);
    console.log(`   detect time  ${r.detectMs} ms`);
    console.log(`   toolbar kept dark      ${r.toolbarPreserved ? "YES" : "NO "}  ${JSON.stringify(r.before.toolbar)} -> ${JSON.stringify(r.after.toolbar)}`);
    console.log(`   left chrome kept dark  ${r.chromePreserved ? "YES" : "NO "}  ${JSON.stringify(r.before.sidebarOrEdge)} -> ${JSON.stringify(r.after.sidebarOrEdge)}`);
    console.log(`   page inverted          ${r.pageInverted ? "YES" : "NO "}  ${JSON.stringify(r.before.pageCentre)} -> ${JSON.stringify(r.after.pageCentre)}`);
    console.log(`   re-detect (naive, overlay on)   ${r.reDetect ? JSON.stringify(r.reDetect) : "none"}`);
    console.log(`   re-detect (un-invert full grab) ${r.noFlash ? JSON.stringify(r.noFlash) : "none"}  matches baseline: ${r.noFlashMatches ? "YES" : "NO"}`);
    console.log("");
  }

  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
  console.log(`screenshots + results in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
