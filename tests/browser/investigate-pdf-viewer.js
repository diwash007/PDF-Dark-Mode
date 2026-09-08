/*
 * Research script (not a test): what does Chrome's built-in PDF viewer actually
 * expose to an extension, and can we target the document content instead of
 * blanketing the whole viewport?
 *
 * Run: CHROME_BIN=/path/to/chrome node tests/browser/investigate-pdf-viewer.js
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { connect } = require("./mini-cdp.js");

const EXTENSION_DIR = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(__dirname, "findings");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A multi-page PDF with black text and a grey box, so inversion is visible. */
function buildPdf() {
  const pages = [];
  const objects = [];
  const pageCount = 2;

  objects.push(null); // 1: catalog
  objects.push(null); // 2: pages
  for (let i = 0; i < pageCount; i += 1) {
    pages.push(3 + i * 2);
    objects.push(null); // page
    objects.push(null); // contents
  }
  const fontId = 3 + pageCount * 2;
  objects.push(null); // font

  objects[0] = "<</Type/Catalog/Pages 2 0 R>>";
  objects[1] = `<</Type/Pages/Kids[${pages.map((p) => `${p} 0 R`).join(" ")}]/Count ${pageCount}>>`;

  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj - 1] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentObj} 0 R` +
      `/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;

    const stream =
      `BT /F1 28 Tf 60 720 Td (Page ${i + 1} heading) Tj ET\n` +
      `BT /F1 12 Tf 60 680 Td (Body copy on a white page, black ink.) Tj ET\n` +
      `0.85 0.85 0.85 rg 60 480 490 160 re f\n` +
      `0 0 0 rg BT /F1 12 Tf 80 560 Td (A light grey figure box) Tj ET`;
    objects[contentObj - 1] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  }
  objects[fontId - 1] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => {
    pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function findChrome() {
  return [
    process.env.CHROME_BIN,
    path.resolve(EXTENSION_DIR, "..", "chrome-linux64", "chrome"),
  ].filter(Boolean).find((p) => fs.existsSync(p));
}

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.log("no Chrome binary; set CHROME_BIN");
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const pdf = buildPdf();

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length });
    res.end(pdf);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const httpPort = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-probe-"));
  const debugPort = 9800 + Math.floor(Math.random() * 300);

  const child = spawn(chromeBin, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--window-size=1280,900",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const findings = {};

  try {
    await sleep(3000);
    const cdp = await connect(debugPort);

    const sessions = new Map();
    cdp.on("event", async (msg) => {
      if (msg.method === "Target.attachedToTarget") {
        sessions.set(msg.params.sessionId, msg.params.targetInfo);
        try {
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, msg.params.sessionId);
        } catch { /* ignore */ }
      }
    });
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    });

    /* ---------------------------------------------- open the PDF */

    const { targetId } = await cdp.send("Target.createTarget", {
      url: `http://127.0.0.1:${httpPort}/doc.pdf`,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("DOM.enable", {}, sessionId);
    await sleep(3500);

    const evaluate = async (expression, sid = sessionId) => {
      try {
        const res = await cdp.send(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sid
        );
        return res.result?.value;
      } catch (e) {
        return { error: e.message };
      }
    };

    /* 1. What is in the top-level document? */
    findings.topLevelDocument = await evaluate(`
      (() => {
        const all = document.querySelectorAll('*');
        return {
          contentType: document.contentType,
          html: document.documentElement.outerHTML.slice(0, 1200),
          elementCount: all.length,
          tags: Array.from(all).map(e => e.tagName.toLowerCase()),
          bodyChildren: document.body ? document.body.children.length : -1,
          embeds: Array.from(document.querySelectorAll('embed,object'))
            .map(e => ({ tag: e.tagName, type: e.type, src: e.src })),
        };
      })()
    `);

    /* 2. Frame tree — is the viewer a child frame? */
    try {
      const tree = await cdp.send("Page.getFrameTree", {}, sessionId);
      const flatten = (node, depth = 0) => [
        { depth, url: node.frame.url, id: node.frame.id, origin: node.frame.securityOrigin },
        ...(node.childFrames || []).flatMap((c) => flatten(c, depth + 1)),
      ];
      findings.frameTree = flatten(tree.frameTree);
    } catch (e) {
      findings.frameTree = { error: e.message };
    }

    /* 3. All browser targets while a PDF is open. */
    const { targetInfos } = await cdp.send("Target.getTargets");
    findings.targets = targetInfos.map((t) => ({ type: t.type, url: t.url }));

    /* 4. Does the viewer hide its UI behind a shadow root? CDP can pierce
     *    shadow DOM; extensions cannot pierce a CLOSED one. If nodes only show
     *    up with pierce:true, they are unreachable from a content script. */
    try {
      const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
      const walk = (node, out = [], depth = 0) => {
        out.push({
          depth,
          name: node.nodeName,
          shadowRootType: node.shadowRootType,
          isShadow: !!node.shadowRootType,
          id: (node.attributes || []).length ? node.attributes.join("=") .slice(0, 80) : "",
        });
        (node.children || []).forEach((c) => walk(c, out, depth + 1));
        (node.shadowRoots || []).forEach((c) => walk(c, out, depth + 1));
        if (node.contentDocument) walk(node.contentDocument, out, depth + 1);
        return out;
      };
      const nodes = walk(doc.root);
      findings.pierceNodeCount = nodes.length;
      findings.shadowRoots = nodes.filter((n) => n.isShadow);
      findings.pierceTree = nodes.slice(0, 60);
    } catch (e) {
      findings.pierceTree = { error: e.message };
    }

    /* 5. Can a CSS filter on the root element invert the rendered PDF? */
    const screenshot = async (label) => {
      const res = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, `${label}.png`), Buffer.from(res.data, "base64"));
      return `${label}.png`;
    };

    await evaluate(`
      (() => { const n = document.getElementById('darkDiv'); if (n) n.remove();
               const t = document.getElementById('tintDiv'); if (t) t.remove();
               return true; })()
    `);
    await sleep(400);
    findings.shots = { baseline: await screenshot("01-baseline-no-extension-layer") };

    await evaluate(`document.documentElement.style.filter = 'invert(1)'; true`);
    await sleep(600);
    findings.shots.rootFilter = await screenshot("02-root-css-filter-invert");
    await evaluate(`document.documentElement.style.filter = ''; true`);

    /* 6. The extension's current technique, for comparison. */
    await evaluate(`
      (() => {
        const d = document.createElement('div');
        d.id = 'probeOverlay';
        d.setAttribute('style',
          'position:fixed;inset:0;background-color:#ffffffff;' +
          'mix-blend-mode:difference;pointer-events:none;z-index:2147483646;');
        document.body.appendChild(d);
        return true;
      })()
    `);
    await sleep(600);
    findings.shots.differenceOverlay = await screenshot("03-difference-blend-overlay");
    await evaluate(`document.getElementById('probeOverlay')?.remove(); true`);

    /* 7. Is there any measurable geometry for the page content? */
    findings.geometry = await evaluate(`
      (() => {
        const out = { viewport: [innerWidth, innerHeight] };
        const embed = document.querySelector('embed');
        if (embed) {
          const r = embed.getBoundingClientRect();
          out.embedRect = { x: r.x, y: r.y, w: r.width, h: r.height };
          out.embedShadow = !!embed.shadowRoot;
        }
        out.elementFromCentre = (() => {
          const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
          return el ? el.tagName + (el.id ? '#' + el.id : '') : null;
        })();
        return out;
      })()
    `);

    /* 8. Which frames can the extension actually script? */
    findings.injectable = await (async () => {
      const workerSession = [...sessions.entries()].find(
        ([, i]) => i.type === "service_worker" && i.url.includes("worker.js")
      )?.[0];
      if (!workerSession) return { error: "no worker session" };

      return evaluate(
        `new Promise(async (resolve) => {
           const tabs = await chrome.tabs.query({});
           const tab = tabs.find(t => t.url && t.url.includes('.pdf'));
           if (!tab) return resolve({ error: 'no pdf tab' });
           try {
             const frames = await chrome.webNavigation?.getAllFrames?.({ tabId: tab.id });
             const results = await chrome.scripting.executeScript({
               target: { tabId: tab.id, allFrames: true },
               func: () => ({ url: location.href, tags: document.querySelectorAll('*').length }),
             });
             resolve({ frames: frames || 'webNavigation permission absent',
                       injectedFrames: results.map(r => r.result) });
           } catch (e) {
             resolve({ error: e.message });
           }
         })`,
        workerSession
      );
    })();

    cdp.close();
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
  }

  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2).slice(0, 6000));
  console.log(`\nfull findings + screenshots in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
