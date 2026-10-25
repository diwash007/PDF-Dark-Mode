/*
 * Executes popup.js for real, in a stubbed Chrome + DOM.
 *
 * This is the closest thing to opening the popup that runs without a browser.
 * It catches the failures a syntax check misses:
 *   - referencing an element id that popup.html does not actually contain
 *     (getElementById returns null here, exactly like in Chrome)
 *   - using a binding before its declaration (temporal dead zone)
 *   - anything that throws during top-level init or first render
 *
 * Run: node tests/popup-smoke.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const popupHtml = fs.readFileSync(path.join(root, "popup/popup.html"), "utf8");
const coreSrc = fs.readFileSync(path.join(root, "scripts/core.js"), "utf8");
const popupSrc = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");

/* Ids and classes that genuinely exist in the popup markup. */
const IDS = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const CLASSES = new Set(
  [...popupHtml.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
);

/* The real <option> list for the mode <select>. */
const MODE_OPTIONS = [
  ...(/<select id="modeSelect">([\s\S]*?)<\/select>/.exec(popupHtml)?.[1] || "").matchAll(
    /value="([^"]+)"/g
  ),
].map((m) => ({ value: m[1], disabled: false }));

assert.ok(IDS.size > 10, "failed to parse ids out of popup.html");
assert.ok(MODE_OPTIONS.length >= 3, "failed to parse mode options out of popup.html");

function makeElement(id) {
  const listeners = {};
  const el = {
    id,
    value: "",
    max: 1000,
    min: 0,
    checked: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    title: "",
    href: "",
    target: "",
    rel: "",
    style: {},
    options: id === "modeSelect" ? MODE_OPTIONS.map((o) => ({ ...o })) : [],
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c);
        else this._set.delete(c);
        return on;
      },
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeAttribute() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    appendChild() {},
    remove() {},
    dispatch(type, event) {
      return Promise.all((listeners[type] || []).map((fn) => fn(event || {})));
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    },
  };
  return el;
}

function buildContext(billing) {
  const elements = new Map();
  const sentMessages = [];
  const syncWrites = [];
  const tabsUpdated = [];
  const tabsCreated = [];
  const getById = (id) => {
    if (!IDS.has(id)) return null; // mirrors Chrome exactly
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const documentStub = {
    getElementById: getById,
    querySelector(selector) {
      const cls = selector.replace(/^\./, "");
      return CLASSES.has(cls) ? makeElement(cls) : null;
    },
    createElement: () => makeElement("created"),
    body: makeElement("body"),
    addEventListener() {},
  };

  const windowListeners = {};
  const chromeStub = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      lastError: null,
      getManifest: () => ({ version: "2.2.0" }),
      getURL: (p) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        if (typeof cb === "function") cb({ ok: true });
      },
    },
    storage: {
      sync: {
        get: (_keys, cb) => cb(billing ? { billing } : {}),
        set: (items, cb) => {
          syncWrites.push(items);
          if (cb) cb();
        },
      },
      local: {
        get: (_keys, cb) => cb({ analytics: { events: {}, pdfAppliesByDay: {} } }),
        set: (_items, cb) => { if (cb) cb(); },
      },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "https://example.com/paper.pdf" }]),
      create: (opts) => { tabsCreated.push(opts); return Promise.resolve({}); },
      update: (tabId, opts) => { tabsUpdated.push({ tabId, opts }); return Promise.resolve({}); },
    },
    scripting: {
      executeScript: () => Promise.resolve([{ result: { width: 1200, height: 800 } }]),
    },
    commands: {
      getAll: (cb) => cb([{ name: "run-dark-mode", shortcut: "Ctrl+Shift+1" }]),
    },
    extension: {
      isAllowedFileSchemeAccess: (cb) => cb(true),
    },
    action: { openPopup: () => Promise.resolve() },
  };

  const context = {
    document: documentStub,
    chrome: chromeStub,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Promise,
    Math,
    Number,
    Array,
    Object,
    JSON,
    String,
    Boolean,
    Date,
    window: {
      addEventListener: (type, fn) => {
        (windowListeners[type] = windowListeners[type] || []).push(fn);
      },
      open: () => {},
    },
  };
  context.globalThis = context;
  context.window.document = documentStub;

  return { context, getById, windowListeners, sentMessages, syncWrites, tabsUpdated, tabsCreated };
}

async function run(billing, label) {
  const { context, getById, windowListeners, sentMessages, syncWrites, tabsUpdated, tabsCreated } =
    buildContext(billing);
  vm.createContext(context);

  new vm.Script(coreSrc, { filename: "scripts/core.js" }).runInContext(context);
  assert.ok(context.PDFDarkModeCore, `core did not attach to globalThis (${label})`);

  new vm.Script(popupSrc, { filename: "popup/popup.js" }).runInContext(context);

  // Let initializePopup's promise chain settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // DOMContentLoaded handler must not blow up either.
  (windowListeners.DOMContentLoaded || []).forEach((fn) => fn());

  return { context, getById, sentMessages, syncWrites, tabsUpdated, tabsCreated };
}

async function main() {
  /* ------------------------------------------------------------ free user */

  {
    const { getById } = await run(null, "free");

    const toggle = getById("toggle");
    assert.ok(toggle.listenerCount("click") > 0, "toggle must be wired up");
    assert.equal(
      getById("toggleStateLabel").textContent,
      "Dark mode on",
      "toggle should default to on"
    );
    assert.equal(
      getById("shortcutHint").textContent,
      "Ctrl + Shift + 1",
      "shortcut hint must come from the commands API, not a hardcoded Mac string"
    );
    assert.equal(getById("planLabel").textContent, "Plan: Free");

    const modes = getById("modeSelect").options;
    assert.equal(modes.find((o) => o.value === "dark").disabled, false, "dark stays available");
    assert.equal(modes.find((o) => o.value === "sepia").disabled, true, "sepia is Pro");
    assert.equal(modes.find((o) => o.value === "amoled").disabled, true, "amoled is Pro");

    assert.equal(
      getById("subscribeBtn").classList.contains("hidden"),
      false,
      "free users should see the upgrade button"
    );
    assert.equal(
      getById("allowCurrentSiteBtn").disabled,
      true,
      "site rules are gated for free users"
    );
    assert.equal(
      getById("replaceTabToggle").checked,
      false,
      "replace original tab toggle defaults to unchecked"
    );
  }

  /* ------------------------------------------------------------- pro user */

  {
    const { getById } = await run(
      { status: "active", plan: "lifetime", licenseKey: "AAAA-BBBB" },
      "pro"
    );

    assert.equal(getById("planLabel").textContent, "Plan: Lifetime");

    const modes = getById("modeSelect").options;
    assert.equal(modes.find((o) => o.value === "sepia").disabled, false, "sepia unlocked for Pro");
    assert.equal(modes.find((o) => o.value === "amoled").disabled, false, "amoled unlocked for Pro");

    assert.equal(
      getById("subscribeBtn").classList.contains("hidden"),
      true,
      "Pro users should not be shown the upgrade button"
    );
    assert.equal(
      getById("allowCurrentSiteBtn").disabled,
      false,
      "site rules are available to Pro"
    );
  }

  /* --------------------------------------- every id popup.js reaches for */

  {
    const referenced = [...popupSrc.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    const missing = referenced.filter((id) => !IDS.has(id));
    assert.deepEqual(missing, [], `popup.js references ids absent from popup.html: ${missing}`);
  }

  /* --------------------------------------- activation tags the browser */

  {
    // The stub has no navigator, so detection degrades to unknown-unknown —
    // the assertion is the format contract, not the value.
    const { getById, sentMessages } = await run(null, "free-activate");
    getById("licenseKeyInput").value = "AAAA-BBBB-CCCC-DDDD";
    await getById("activateLicenseBtn").dispatch("click");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const activation = sentMessages.find((m) => m?.type === "license-activate");
    assert.ok(activation, "activate must send a license-activate message");
    assert.match(
      activation.browser || "",
      /^[a-z]+-[a-z]+$/,
      "activation must carry a family-os browser tag"
    );
  }

  /* --------------------------------------- replace original tab toggle */

  {
    const { getById, syncWrites, tabsUpdated, sentMessages } = await run(null, "replace-tab-toggle");
    const toggle = getById("replaceTabToggle");
    assert.equal(toggle.checked, false, "starts false");
    toggle.checked = true;
    await toggle.dispatch("change");
    assert.ok(
      syncWrites.some((w) => w.replaceOriginalTab === true),
      "checking toggle persists replaceOriginalTab: true"
    );

    const fullDarkBtn = getById("fullDarkBtn");
    await fullDarkBtn.dispatch("click");
    assert.equal(tabsUpdated.length, 1, "clicking fullDarkBtn in replace mode must update current tab");
    assert.equal(tabsUpdated[0].tabId, 1);
    assert.ok(tabsUpdated[0].opts.url.includes("viewer/viewer.html"));
  }

  {
    const { getById, sentMessages, tabsUpdated } = await run(null, "new-tab-mode");
    const fullDarkBtn = getById("fullDarkBtn");
    await fullDarkBtn.dispatch("click");
    assert.equal(tabsUpdated.length, 0, "must not update tab when replaceOriginalTab is false");
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].type, "open-viewer");
    assert.equal(sentMessages[0].replaceTab, false);
  }

  console.log("popup-smoke: popup.js initialises cleanly for free and Pro, all ids resolve");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
