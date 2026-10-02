/*
 * Structural guards. These are the cheap checks that catch the failures which
 * actually break a shipped extension: a renamed file the manifest still points
 * at, a syntax error, a third-party request sneaking back in, or the overlay
 * renderer getting copy-pasted a fourth time.
 *
 * Run: node tests/integrity.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  void name;
};

/* ------------------------------------------------------------- manifest */

const manifest = JSON.parse(read("manifest.json"));

check("manifest points at files that exist", () => {
  assert.ok(exists(manifest.background.service_worker), "service worker missing");
  assert.ok(exists(manifest.action.default_popup), "popup missing");

  Object.values(manifest.icons || {}).forEach((icon) => {
    assert.ok(exists(icon.replace(/^\//, "")), `icon missing: ${icon}`);
  });
  Object.values(manifest.action.default_icon || {}).forEach((icon) => {
    assert.ok(exists(icon.replace(/^\//, "")), `action icon missing: ${icon}`);
  });
});

check("manifest still declares the shortcut command the popup reads", () => {
  assert.ok(manifest.commands?.["run-dark-mode"], "run-dark-mode command missing");
});

check("no new permissions were introduced", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "alarms", "scripting", "storage", "tabs"],
    "permission set changed — this needs a store review note"
  );
});

/* ------------------------------------------------------- files injected */

const worker = read("worker.js");

check("every file the worker injects exists", () => {
  const match = /CONTENT_SCRIPT_FILES\s*=\s*\[([^\]]+)\]/.exec(worker);
  assert.ok(match, "could not find CONTENT_SCRIPT_FILES");

  const files = match[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, ""));
  assert.deepEqual(files, ["scripts/core.js", "scripts/invert.js"]);
  files.forEach((file) => assert.ok(exists(file), `injected file missing: ${file}`));
});

check("core is loaded everywhere it is used", () => {
  assert.match(worker, /importScripts\("scripts\/core\.js"\)/, "worker must importScripts core");

  const popupHtml = read("popup/popup.html");
  assert.match(popupHtml, /src="\.\.\/scripts\/core\.js"/, "popup must load core");
  assert.ok(
    popupHtml.indexOf("../scripts/core.js") < popupHtml.indexOf("popup.js"),
    "core must be loaded before popup.js"
  );

  const viewerHtml = read("viewer/viewer.html");
  assert.match(viewerHtml, /src="\.\.\/scripts\/core\.js"/, "viewer must load core");
  assert.ok(
    viewerHtml.indexOf("../scripts/core.js") < viewerHtml.indexOf("viewer.js"),
    "core must be loaded before viewer.js"
  );
});

check("the full-dark viewer ships its vendored renderer", () => {
  ["viewer/viewer.html", "viewer/viewer.css", "viewer/viewer.js",
    "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs",
  ].forEach((file) => assert.ok(exists(file), `viewer file missing: ${file}`));
});

check("every id viewer.js reaches for exists in viewer.html", () => {
  const html = read("viewer/viewer.html");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...read("viewer/viewer.js").matchAll(/getElementById\("([^"]+)"\)/g)].map(
    (m) => m[1]
  );
  assert.ok(referenced.length > 5, "expected viewer.js to reference several ids");
  const missing = referenced.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `viewer.js references ids absent from viewer.html: ${missing}`);
});

/* ------------------------------------------------------------- parsing */

const jsFiles = ["worker.js", "scripts/core.js", "scripts/invert.js", "popup/popup.js", "instruction/index.js", "viewer/viewer.js"];

check("all extension scripts parse", () => {
  jsFiles.forEach((file) => {
    assert.doesNotThrow(
      () => new vm.Script(read(file), { filename: file }),
      `syntax error in ${file}`
    );
  });
});

/* --------------------------------------------------- no external calls */

check("no third-party CDNs or webfonts", () => {
  const shipped = [
    "popup/popup.html",
    "popup/popup.css",
    "instruction/index.html",
    "instruction/update.html",
    "instruction/style.css",
    "viewer/viewer.html",
    "viewer/viewer.css",
  ];

  const banned = /(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com|jsdelivr\.net)/i;

  shipped.forEach((file) => {
    const body = read(file).replace(/\/\*[\s\S]*?\*\//g, ""); // ignore comments
    assert.ok(!banned.test(body), `${file} reaches out to a third party`);
  });
});

check("the only network endpoint is the licence API", () => {
  const endpoints = new Set();
  jsFiles.forEach((file) => {
    const body = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const matches = body.match(/https?:\/\/[^\s"'`)]+/g) || [];
    matches
      // Skip template literals like `https://${host}` — those build a URL from
      // user input for parsing, they are not endpoints.
      .filter((url) => !url.includes("${"))
      .forEach((url) => endpoints.add(new URL(url.replace(/[.,;]$/, "")).host));
  });

  // pdf-dark.com is opened in a tab on user click, not fetched.
  const allowed = new Set(["api.lemonsqueezy.com", "pdf-dark.com"]);
  endpoints.forEach((host) => {
    assert.ok(allowed.has(host), `unexpected network host: ${host}`);
  });
});

check("global .hidden stays the last display rule in popup.css", () => {
  // Same specificity as component classes, so source order decides: a
  // display:flex/grid declared after .hidden overrides it and the element
  // stays visible (this once kept the file-access banner stuck on screen).
  const css = read("popup/popup.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const hiddenRules = [...css.matchAll(/\.hidden\s*\{[^}]*display\s*:\s*none[^}]*\}/g)];
  assert.ok(hiddenRules.length >= 1, "global .hidden rule missing from popup.css");

  const lastHidden = hiddenRules[hiddenRules.length - 1];
  const lastHiddenEnd = lastHidden.index + lastHidden[0].length;
  const displaysAfter = (css.slice(lastHiddenEnd).match(/display\s*:/g) || []).length;
  assert.equal(
    displaysAfter,
    0,
    ".hidden must be the last display rule in popup.css — move it back to the end"
  );
});

/* ------------------------------------------- single overlay implementation */

check("the overlay renderer exists exactly once", () => {
  const sources = ["scripts/core.js", "scripts/invert.js", "popup/popup.js", "worker.js"];
  const owners = sources.filter((file) => read(file).includes("mix-blend-mode: difference"));

  assert.deepEqual(
    owners,
    ["scripts/core.js"],
    "the difference-blend overlay must only be built in core.js — it was previously " +
      "hand-written in three places and drifted apart"
  );
});

check("no leftover duplicate policy helpers", () => {
  ["popup/popup.js", "scripts/invert.js"].forEach((file) => {
    const body = read(file);
    assert.ok(
      !/function\s+buildUrlPolicy\s*\(/.test(body),
      `${file} still defines its own buildUrlPolicy`
    );
    assert.ok(
      !/function\s+defaultBilling\s*\(/.test(body),
      `${file} still defines its own defaultBilling`
    );
  });
});

console.log(`integrity: ${passed} checks passed`);
