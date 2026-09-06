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
});

/* ------------------------------------------------------------- parsing */

const jsFiles = ["worker.js", "scripts/core.js", "scripts/invert.js", "popup/popup.js", "instruction/index.js"];

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

  // diwashdahal.com.np is opened in a tab on user click, not fetched.
  const allowed = new Set(["api.lemonsqueezy.com", "diwashdahal.com.np"]);
  endpoints.forEach((host) => {
    assert.ok(allowed.has(host), `unexpected network host: ${host}`);
  });
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
