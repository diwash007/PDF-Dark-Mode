/*
 * End-to-end test in a real Chrome with the extension loaded unpacked.
 *
 * This exists because the unit suites all passed while the extension was broken
 * in the browser: the worker test stubbed importScripts(), so a service worker
 * that failed to boot still looked healthy.
 *
 * Needs a Chrome binary. Point CHROME_BIN at one, or drop chrome-linux64 next to
 * the repo. Skips (exit 0) when no binary is available so CI without Chrome is
 * not blocked.
 *
 * Run: node tests/browser/extension.test.js
 */

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { connect } = require("./mini-cdp.js");

const EXTENSION_DIR = path.resolve(__dirname, "..", "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    path.resolve(EXTENSION_DIR, "..", "chrome-linux64", "chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

/* ------------------------------------------------------------- fixtures */

function buildPdf() {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
      "/Resources<</Font<</F1 5 0 R>>>>>>",
    null, // stream, built below
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  const text = "BT /F1 24 Tf 72 700 Td (PDF Dark Mode integration test) Tj ET";
  objects[3] = `<</Length ${text.length}>>\nstream\n${text}\nendstream`;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

function startServer(pdf) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".pdf") || url.searchParams.get("file")?.endsWith(".pdf")) {
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length });
      res.end(pdf);
      return;
    }
    if (url.pathname === "/search") {
      // Stands in for a search results page whose URL mentions a PDF.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>results</title><body><h1>Results</h1></body>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>plain</title><body><p>Nothing to see.</p></body>");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------------- chrome */

function launch(chromeBin, profileDir, port) {
  const child = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DialMediaRouteProvider",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  return { child, logs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/json/version" }, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
      });
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await sleep(250);
    }
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.log("browser: SKIPPED (no Chrome binary; set CHROME_BIN)");
    return;
  }

  const pdf = buildPdf();
  const { server, port: httpPort } = await startServer(pdf);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-profile-"));
  const debugPort = 9333 + Math.floor(Math.random() * 400);

  const { child, logs } = launch(chromeBin, profileDir, debugPort);

  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
  };

  try {
    if (!(await waitForPort(debugPort))) {
      throw new Error(`Chrome never opened the debug port.\n${logs.join("")}`);
    }

    const cdp = await connect(debugPort);

    /* Collect everything the service worker says, including boot failures. */
    const workerErrors = [];
    const workerLogs = [];
    const sessions = new Map();

    cdp.on("event", async (msg) => {
      if (msg.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(sessionId, targetInfo);
        try {
          await cdp.send("Runtime.enable", {}, sessionId);
          await cdp.send("Log.enable", {}, sessionId);
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
        } catch { /* target may already be gone */ }
        return;
      }

      const info = sessions.get(msg.sessionId);
      const isWorker = info && info.type === "service_worker";

      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        const text = d.exception?.description || d.text || "unknown exception";
        (isWorker ? workerErrors : workerLogs).push(`${info?.type || "?"}: ${text}`);
      }

      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        const entry = msg.params.entry;
        (isWorker ? workerErrors : workerLogs).push(
          `${info?.type || "?"}: ${entry.text} ${entry.url || ""}`
        );
      }
    });

    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    // Give the extension a moment to install and boot its worker.
    await sleep(2500);

    const { targetInfos } = await cdp.send("Target.getTargets");
    const workerTarget = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.includes("worker.js")
    );

    const extensionId = workerTarget
      ? new URL(workerTarget.url).host
      : (targetInfos.find((t) => t.url.startsWith("chrome-extension://")) || {}).url
          ?.split("/")[2];

    const results = [];
    const record = (name, ok, detail) => results.push({ name, ok, detail });

    record("service worker target exists", !!workerTarget, workerTarget?.url);

    /* --- does the worker's global actually have core on it? --- */
    let coreOnWorker = null;
    if (workerTarget) {
      const sessionId = [...sessions.entries()].find(
        ([, info]) => info.targetId === workerTarget.targetId
      )?.[0];

      if (sessionId) {
        try {
          const res = await cdp.send(
            "Runtime.evaluate",
            {
              expression:
                "({ core: typeof globalThis.PDFDarkModeCore, " +
                "hasImportScripts: typeof importScripts, " +
                "listeners: typeof chrome.tabs.onUpdated })",
              returnByValue: true,
            },
            sessionId
          );
          coreOnWorker = res.result?.value;
        } catch (e) {
          coreOnWorker = { error: e.message };
        }
      }
    }
    record(
      "worker booted with core attached",
      coreOnWorker && coreOnWorker.core === "object",
      JSON.stringify(coreOnWorker)
    );

    /* Run an expression inside the extension's service worker. */
    const workerSessionId = () =>
      [...sessions.entries()].find(
        ([, info]) => info.type === "service_worker" && info.url.includes("worker.js")
      )?.[0];

    async function inWorker(expression) {
      const sessionId = workerSessionId();
      if (!sessionId) return { error: "no worker session" };
      const res = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      return res.result?.value;
    }

    /* Seed chrome.storage.sync the way an upgrading 2.1.3 user's profile looks. */
    async function seedStorage(state) {
      return inWorker(
        `new Promise((resolve) => chrome.storage.sync.clear(() =>
           chrome.storage.sync.set(${JSON.stringify(state)}, () => resolve("ok"))))`
      );
    }

    const PROBE =
      "({ overlay: !!document.getElementById('darkDiv')," +
      " tint: !!document.getElementById('tintDiv')," +
      " dock: !!document.getElementById('pdfDarkModeDock')," +
      " overlayCount: document.querySelectorAll('#darkDiv').length," +
      " dockCount: document.querySelectorAll('#pdfDarkModeDock').length," +
      " contentType: document.contentType, href: location.href })";

    async function openTab(url) {
      const { targetId } = await cdp.send("Target.createTarget", { url });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await sleep(2500);
      return { targetId, sessionId };
    }

    async function probe(sessionId) {
      try {
        const res = await cdp.send(
          "Runtime.evaluate",
          { expression: PROBE, returnByValue: true },
          sessionId
        );
        return res.result?.value ?? { error: "no value" };
      } catch (e) {
        return { error: e.message };
      }
    }

    /* --- open a real PDF and look for the overlay --- */
    async function openAndInspect(urlPath, label) {
      const { targetId } = await cdp.send("Target.createTarget", {
        url: `http://127.0.0.1:${httpPort}${urlPath}`,
      });
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await sleep(2500);

      let value = { error: "evaluate failed" };
      try {
        const res = await cdp.send(
          "Runtime.evaluate",
          {
            expression:
              "({ overlay: !!document.getElementById('darkDiv'),"
              + " tint: !!document.getElementById('tintDiv'),"
              + " embedTypes: Array.from(document.querySelectorAll('embed,object')).map(e => e.type),"
              + " matchesPdfSelector: !!document.querySelector('embed[type=\"application/pdf\"]'),"
              + " contentType: document.contentType,"
              + " bodyChildren: document.body ? document.body.children.length : -1," +
              " dock: !!document.getElementById('pdfDarkModeDock')," +
              " href: location.href })",
            returnByValue: true,
          },
          sessionId
        );
        value = res.result?.value ?? value;
      } catch (e) {
        value = { error: e.message };
      }

      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      return { label, ...value };
    }

    const onPdf = await openAndInspect("/paper.pdf", "pdf");
    record("overlay applied on a PDF at first load", onPdf.overlay === true, JSON.stringify(onPdf));
    record("floating dock visible on a PDF", onPdf.dock === true, JSON.stringify(onPdf));

    const onSearch = await openAndInspect("/search?q=report.pdf&hl=en", "search");
    record(
      "search page mentioning a pdf stays light",
      onSearch.overlay === false,
      JSON.stringify(onSearch)
    );

    const onPlain = await openAndInspect("/", "plain");
    record("ordinary page untouched", onPlain.overlay === false, JSON.stringify(onPlain));

    /* ---------------------------------------------------- upgrade paths */

    // Exactly what a 2.1.3 profile holds: no showDock key at all.
    const LEGACY = {
      active: true,
      strength: 255,
      contrast: 100,
      mode: "dark",
      siteRules: {},
      billing: {
        plan: "free",
        status: "inactive",
        source: "free",
        licenseKey: "",
        instanceId: "",
        instanceName: "",
        lastValidatedAt: "",
        lastValidationAttemptAt: "",
        licenseStatus: "not_configured",
        errorMessage: "",
      },
    };

    // The case that reproduces the report: a URL that only mentions .pdf in its
    // query string, but genuinely serves a PDF.
    const dynamic = await openAndInspect("/download?file=report.pdf", "dynamic-pdf");
    record(
      "dynamic PDF endpoint still darkens",
      dynamic.overlay === true,
      JSON.stringify(dynamic)
    );

    await seedStorage(LEGACY);
    const upgraded = await openAndInspect("/paper.pdf", "upgrade");
    record("upgrade from 2.1.3: overlay applies", upgraded.overlay === true, JSON.stringify(upgraded));
    record("upgrade from 2.1.3: dock visible", upgraded.dock === true, JSON.stringify(upgraded));

    // A user who ever pressed the shortcut on 2.1.3 has active:false persisted,
    // because the old build wrote the flag but never honoured it.
    await seedStorage({ ...LEGACY, active: false });
    const staleOff = await openAndInspect("/paper.pdf", "stale-active-false");
    record(
      "stale active:false stays off (documented behaviour change)",
      staleOff.overlay === false,
      JSON.stringify(staleOff)
    );

    await seedStorage({ ...LEGACY, active: true });
    const backOn = await openAndInspect("/paper.pdf", "reactivated");
    record("switching back on survives a reload", backOn.overlay === true, JSON.stringify(backOn));

    // Pro user with a saved per-site overlay area.
    await seedStorage({
      ...LEGACY,
      mode: "sepia",
      billing: { ...LEGACY.billing, status: "active", plan: "lifetime" },
      siteOverlayAreas: { "127.0.0.1": { top: 40, right: 0, bottom: 0, left: 0 } },
    });
    const pro = await openAndInspect("/paper.pdf", "pro-sepia");
    record("pro sepia renders both layers", pro.overlay === true && pro.tint === true, JSON.stringify(pro));

    await seedStorage(LEGACY);

    /* ------------------------------- live toggling in an already-open tab */

    {
      const tab = await openTab(`http://127.0.0.1:${httpPort}/paper.pdf`);
      const before = await probe(tab.sessionId);
      record("open PDF starts dark", before.overlay === true, JSON.stringify(before));

      // This is what the keyboard shortcut does: flip the flag and let the
      // worker fan the change out to every open PDF.
      await inWorker(
        `new Promise((r) => chrome.storage.sync.set({ active: false }, () => r("ok")))`
      );
      await sleep(2000);
      const off = await probe(tab.sessionId);
      record(
        "switching off clears an already-open tab",
        off.overlay === false && off.dock === false,
        JSON.stringify(off)
      );

      await inWorker(
        `new Promise((r) => chrome.storage.sync.set({ active: true }, () => r("ok")))`
      );
      await sleep(2000);
      const backOnLive = await probe(tab.sessionId);
      record(
        "switching on restores it without a reload",
        backOnLive.overlay === true && backOnLive.dock === true,
        JSON.stringify(backOnLive)
      );
      record(
        "repeated re-injection leaves exactly one overlay and one dock",
        backOnLive.overlayCount === 1 && backOnLive.dockCount === 1,
        JSON.stringify(backOnLive)
      );

      await cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
    }

    /* ------------------------------------------------- the popup itself */

    if (extensionId) {
      const popup = await openTab(`chrome-extension://${extensionId}/popup/popup.html`);
      let ui = { error: "not evaluated" };
      try {
        const res = await cdp.send(
          "Runtime.evaluate",
          {
            expression:
              "({ toggle: !!document.getElementById('toggle')," +
              " toggleLabel: document.getElementById('toggleStateLabel')?.textContent," +
              " shortcut: document.getElementById('shortcutHint')?.textContent," +
              " dockToggleInEssential: !!document.querySelector('#essentialTabPanel #showDockToggle')," +
              " dockToggleInAdvanced: !!document.querySelector('#advancedTabPanel #showDockToggle')," +
              " plan: document.getElementById('planLabel')?.textContent," +
              " modeOptions: Array.from(document.getElementById('modeSelect').options)" +
              "   .map(o => o.value + (o.disabled ? ':locked' : ':open')) })",
            returnByValue: true,
          },
          popup.sessionId
        );
        ui = res.result?.value ?? ui;
      } catch (e) {
        ui = { error: e.message };
      }

      record("popup renders", ui.toggle === true, JSON.stringify(ui));
      record("popup toggle shows a text state", !!ui.toggleLabel, JSON.stringify(ui.toggleLabel));
      record(
        "shortcut hint is populated from the commands API",
        typeof ui.shortcut === "string" && /Shift/.test(ui.shortcut),
        JSON.stringify(ui.shortcut)
      );
      record(
        "floating-button setting lives in Essential, not Advanced",
        ui.dockToggleInEssential === true && ui.dockToggleInAdvanced === false,
        JSON.stringify(ui)
      );
      record(
        "free plan locks the Pro modes",
        Array.isArray(ui.modeOptions) &&
          ui.modeOptions.includes("dark:open") &&
          ui.modeOptions.includes("sepia:locked"),
        JSON.stringify(ui.modeOptions)
      );

      await cdp.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});
    }

    /* ------------------------------------------------------------ report */

    console.log(`\nChrome ${chromeBin}`);
    console.log(`extension id: ${extensionId || "unknown"}\n`);

    results.forEach((r) => {
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
      if (!r.ok && r.detail) console.log(`        ${r.detail}`);
    });

    if (workerLogs.length) {
      console.log("\n  page/extension errors:");
      [...new Set(workerLogs)].forEach((e) => console.log(`    ${e}`));
    }

    if (workerErrors.length) {
      console.log("\n  service worker errors:");
      [...new Set(workerErrors)].forEach((e) => console.log(`    ${e}`));
    } else {
      console.log("\n  service worker errors: none");
    }

    cdp.close();

    const failures = results.filter((r) => !r.ok);
    if (failures.length || workerErrors.length) {
      throw new Error(
        `${failures.length} browser assertion(s) failed, ${workerErrors.length} worker error(s)`
      );
    }

    console.log("\nbrowser: all checks passed");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
