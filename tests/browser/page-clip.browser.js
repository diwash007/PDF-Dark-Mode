/*
 * End-to-end proof of the experimental page clip, in real Chrome.
 *
 * Headless auto-denies the optional <all_urls> prompt (there is no UI to accept
 * it), so this loads a COPY of the extension with that origin pre-granted in the
 * manifest. Everything else — captureVisibleTab, the OffscreenCanvas decode, the
 * detector, the clipped overlay — is the shipped code path.
 *
 * The denial path is covered by extension.test.js instead.
 *
 * Verified by outcome: the toolbar and sidebar must still match an untouched
 * Chrome, and the page must be inverted.
 *
 * Run: CHROME_BIN=... node tests/browser/page-clip.browser.js
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { connect } = require("./mini-cdp.js");

const EXT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "findings", "feature");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- fixtures */

function makePdf({ dark = false } = {}) {
  const objs = ["<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>", null, null, null, null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  [3, 5].forEach((p, i) => {
    objs[p - 1] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${p + 1} 0 R` +
      `/Resources<</Font<</F1 7 0 R>>>>>>`;
    const body = dark
      ? `0.08 0.08 0.10 rg 0 0 612 792 re f\n1 1 1 rg\n` +
        `BT /F1 26 Tf 60 700 Td (Already dark ${i + 1}) Tj ET`
      : `BT /F1 28 Tf 60 720 Td (Page ${i + 1} heading) Tj ET\n` +
        `BT /F1 12 Tf 60 680 Td (Black ink on a white page.) Tj ET\n` +
        `0.85 0.85 0.85 rg 60 460 490 170 re f`;
    objs[p] = `<</Length ${body.length}>>\nstream\n${body}\nendstream`;
  });
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((b, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => { pdf += `${String(o).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function pixelAt(file, x, y) {
  return execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert("RGB")
print(*im.getpixel((${x}, ${y})))
`], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
}
const near = (a, b, tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const lum = (p) => (p[0] * 299 + p[1] * 587 + p[2] * 114) / 1000;

/** Copy the extension and pre-grant <all_urls>, since headless cannot prompt. */
function stageExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-ext-"));
  for (const entry of ["manifest.json", "worker.js", "scripts", "popup", "images", "instruction"]) {
    const from = path.join(EXT, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, entry), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  delete manifest.optional_host_permissions;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const chromeBin = process.env.CHROME_BIN ||
    path.resolve(EXT, "..", "chrome-linux64", "chrome");
  if (!fs.existsSync(chromeBin)) {
    console.log("page-clip browser: SKIPPED (no Chrome binary)");
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });

  const extDir = stageExtension();
  const light = makePdf();
  const dark = makePdf({ dark: true });

  const server = http.createServer((req, res) => {
    const body = req.url.includes("dark") ? dark : light;
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-feat-"));
  const dp = 9350 + Math.floor(Math.random() * 150);
  const child = spawn(chromeBin, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--window-size=1280,900",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${dp}`,
    `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });

  try {
    await sleep(3000);
    const cdp = await connect(dp);
    const sessions = new Map();
    const workerErrors = [];

    cdp.on("event", async (msg) => {
      if (msg.method === "Target.attachedToTarget") {
        sessions.set(msg.params.sessionId, msg.params.targetInfo);
        try {
          await cdp.send("Runtime.enable", {}, msg.params.sessionId);
          await cdp.send("Log.enable", {}, msg.params.sessionId);
        } catch { /* gone */ }
        return;
      }
      const info = sessions.get(msg.sessionId);
      if (info?.type !== "service_worker") return;
      if (msg.method === "Runtime.exceptionThrown") {
        workerErrors.push(msg.params.exceptionDetails?.exception?.description || "exception");
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        workerErrors.push(msg.params.entry.text);
      }
    });
    await cdp.send("Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(1500);

    const workerSession = () => [...sessions.entries()]
      .find(([, i]) => i.type === "service_worker" && i.url.includes("worker.js"))?.[0];

    const inWorker = async (expression) => {
      const sid = workerSession();
      if (!sid) return { error: "no worker" };
      const r = await cdp.send("Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true }, sid);
      return r.result?.value;
    };

    const seed = (state) => inWorker(
      `new Promise((r) => chrome.storage.sync.clear(() =>
         chrome.storage.sync.set(${JSON.stringify(state)}, () => r("ok"))))`
    );

    const BASE = {
      active: true, strength: 255, contrast: 100, mode: "dark",
      siteRules: {}, showDock: true,
      billing: { plan: "free", status: "inactive", source: "free", licenseKey: "",
        instanceId: "", instanceName: "", lastValidatedAt: "", lastValidationAttemptAt: "",
        licenseStatus: "not_configured", errorMessage: "" },
    };

    async function scenario(label, url, state, settleMs = 4200) {
      await seed(state);
      const { targetId } = await cdp.send("Target.createTarget", { url });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Target.activateTarget", { targetId }).catch(() => {});
      await sleep(settleMs);

      const shoot = async (tag) => {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        const f = path.join(OUT, `${label}-${tag}.png`);
        fs.writeFileSync(f, Buffer.from(r.data, "base64"));
        return f;
      };
      const ev = async (expr) => (await cdp.send("Runtime.evaluate",
        { expression: expr, returnByValue: true }, sessionId)).result?.value;

      const withOverlay = await shoot("applied");
      const style = await ev(
        "(() => { const d = document.getElementById('darkDiv');" +
        " return d ? d.getAttribute('style') : null; })()"
      );

      // Strip our layers for a clean reference of what Chrome draws.
      await ev("['darkDiv','tintDiv','pdfDarkModeDock']" +
        ".forEach(id => document.getElementById(id)?.remove()); true");
      await sleep(400);
      const bare = await shoot("bare");

      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      return { withOverlay, bare, style };
    }

    const pdfUrl = `http://127.0.0.1:${port}/doc.pdf`;
    const darkUrl = `http://127.0.0.1:${port}/darkdoc.pdf`;
    const P = { toolbar: [640, 20], sidebar: [12, 450], page: [800, 300] };

    /* --- clip OFF: today's behaviour, the whole viewport inverts --- */
    {
      const r = await scenario("off", pdfUrl, { ...BASE, pageClip: false });
      const t = [pixelAt(r.bare, ...P.toolbar), pixelAt(r.withOverlay, ...P.toolbar)];
      record("clip OFF: toolbar still inverts (unchanged behaviour)",
        !near(t[0], t[1]), JSON.stringify(t));
    }

    /* --- clip ON: only the page should invert --- */
    {
      const r = await scenario("on", pdfUrl, { ...BASE, pageClip: true });
      const toolbar = [pixelAt(r.bare, ...P.toolbar), pixelAt(r.withOverlay, ...P.toolbar)];
      const sidebar = [pixelAt(r.bare, ...P.sidebar), pixelAt(r.withOverlay, ...P.sidebar)];
      const page = [pixelAt(r.bare, ...P.page), pixelAt(r.withOverlay, ...P.page)];

      record("clip ON: overlay is inset, not full-viewport",
        !!r.style && !/top:\s*0px;.*left:\s*0px/.test(r.style), r.style?.slice(0, 150));
      record("clip ON: toolbar keeps Chrome's own colour",
        near(toolbar[0], toolbar[1]), JSON.stringify(toolbar));
      record("clip ON: sidebar keeps Chrome's own colour",
        near(sidebar[0], sidebar[1]), JSON.stringify(sidebar));
      record("clip ON: the page itself is inverted",
        Math.abs(lum(page[0]) - lum(page[1])) > 80, JSON.stringify(page));
    }

    /* --- dark PDF: nothing to lock on to, must fall back --- */
    {
      const r = await scenario("darkpdf", darkUrl, { ...BASE, pageClip: true });
      record("dark PDF falls back to the full-viewport overlay",
        !!r.style && /top:\s*0px/.test(r.style) && /left:\s*0px/.test(r.style),
        r.style?.slice(0, 150));
    }

    record("no service worker errors", workerErrors.length === 0,
      [...new Set(workerErrors)].join(" | "));

    cdp.close();
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
  }

  console.log("");
  results.forEach((r) => {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.ok && r.detail) console.log(`        ${r.detail}`);
  });
  console.log(`\nscreenshots in ${OUT}`);

  const failed = results.filter((r) => !r.ok).length;
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("page-clip browser: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
