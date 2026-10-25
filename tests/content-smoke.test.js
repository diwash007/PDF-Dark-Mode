/*
 * Executes scripts/invert.js against a hand-rolled DOM, the way the worker
 * injects it: core.js first, then invert.js, in one shared global.
 *
 * The previous test suite never did this. It tested core's pure functions and
 * stubbed everything around them, so a content script that silently painted
 * nothing would still have gone green.
 *
 * Run: node tests/content-smoke.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const coreSrc = fs.readFileSync(path.join(root, "scripts/core.js"), "utf8");
const invertSrc = fs.readFileSync(path.join(root, "scripts/invert.js"), "utf8");

/* --------------------------------------------------------------- fake DOM */

function makeDom({ embeds = [], contentType = "text/html" } = {}) {
  const byId = new Map();

  function makeNode(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      _id: "",
      get id() { return this._id; },
      set id(v) { this._id = v; byId.set(v, this); },
      children: [],
      attributes: {},
      textContent: "",
      type: "",
      title: "",
      _listeners: {},
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k] ?? null; },
      removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
        if (this._id) byId.delete(this._id);
      },
      querySelector(sel) {
        if (/embed\[type="application\/pdf"\]/.test(sel) && embeds.includes("embed")) {
          return makeNode("embed");
        }
        if (/#viewerContainer|\.pdfViewer|canvas\.pdfPage/.test(sel) && embeds.includes("pdfjs")) {
          return makeNode("div");
        }
        return null;
      },
      click() { (this._listeners.click || []).forEach((fn) => fn({})); },
      find(id) {
        if (this._id === id) return this;
        for (const c of this.children) {
          const hit = c.find(id);
          if (hit) return hit;
        }
        return null;
      },
    };
    return node;
  }

  const body = makeNode("body");
  const documentElement = makeNode("html");

  const docListeners = {};
  const document = {
    body,
    documentElement,
    contentType,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => body.querySelector(sel) || documentElement.querySelector(sel),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    dispatchEvent: (e) => {
      const type = typeof e === "string" ? e : e?.type;
      (docListeners[type] || []).forEach((fn) => fn(e));
    },
  };

  return { document, body };
}

/* Settings for a user upgrading from 2.1.3: note `showDock` does not exist. */
function legacyUserState(overrides = {}) {
  return {
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
    overlayAreaSettings: { top: 0, right: 0, bottom: 0, left: 0 },
    siteOverlayAreas: {},
    ...overrides,
  };
}

function inject({
  href,
  state,
  embeds = [],
  contentType = "text/html",
  preloadedCore = false,
  sessionStorage = null,
}) {
  const { document, body } = makeDom({ embeds, contentType });
  const messages = [];
  const errors = [];
  const openedWindows = [];

  const sessionStore = sessionStorage || {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  };

  const context = {
    document,
    window: {
      location: { href },
      open: (url, target, features) => {
        openedWindows.push({ url, target, features });
      },
      addEventListener: (t, fn) => { document.addEventListener(t, fn); },
      sessionStorage: sessionStore,
    },
    sessionStorage: sessionStore,
    console: { error: (...a) => errors.push(a.join(" ")), log: () => {}, warn: () => {} },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          messages.push(msg);
          if (typeof cb === "function") cb({ ok: true });
        },
        getURL: (p) => `chrome-extension://x/${p}`,
      },
      storage: { sync: { get: (_keys, cb) => cb(state) } },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    Node: { ELEMENT_NODE: 1 },
    URL,
    Promise,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Date,
    Set,
  };
  context.globalThis = context;
  context.window.document = document;
  vm.createContext(context);

  if (preloadedCore) {
    // Simulates a re-injection into a page that already has core loaded.
    new vm.Script(coreSrc, { filename: "core-first" }).runInContext(context);
  }
  new vm.Script(coreSrc, { filename: "scripts/core.js" }).runInContext(context);
  new vm.Script(invertSrc, { filename: "scripts/invert.js" }).runInContext(context);

  return {
    context,
    body,
    errors,
    messages,
    openedWindows,
    triggerEvent: (type) => document.dispatchEvent(type),
    overlay: () => document.getElementById("darkDiv"),
    tint: () => document.getElementById("tintDiv"),
    dock: () => document.getElementById("pdfDarkModeDock"),
  };
}

/* ------------------------------------------------------------------ tests */

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  void name;
};

check("a plain PDF gets the overlay on first injection", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/2411.08442v2.pdf",
    state: legacyUserState(),
    contentType: "application/pdf",
  });
  assert.deepEqual(r.errors, [], "no errors expected");
  assert.ok(r.overlay(), "the dark layer must be painted on first load");
  assert.match(r.overlay().getAttribute("style"), /mix-blend-mode: difference/);
});

check("the floating dock appears for a user with no showDock setting", () => {
  const r = inject({ href: "https://arxiv.org/pdf/a.pdf", state: legacyUserState() });
  assert.ok(
    r.dock(),
    "an existing user upgrading has no showDock key; the dock must still show"
  );
});

check("showDock:false hides the dock but keeps the overlay", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState({ showDock: false }),
  });
  assert.ok(r.overlay(), "overlay still applies");
  assert.equal(r.dock(), null, "dock suppressed");
});

check("the global switch off means no overlay and no dock", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState({ active: false }),
  });
  assert.equal(r.overlay(), null);
  assert.equal(r.dock(), null);
});

check("a non-PDF page is untouched", () => {
  const r = inject({ href: "https://example.com/", state: legacyUserState() });
  assert.equal(r.overlay(), null);
  assert.equal(r.dock(), null);
});

check("a search page mentioning a pdf stays light", () => {
  const r = inject({
    href: "https://www.google.com/search?q=report.pdf&hl=en",
    state: legacyUserState(),
  });
  assert.equal(r.overlay(), null, "no PDF embed present, so nothing should paint");
});

check("an ambiguous URL paints when the document really is a PDF", () => {
  // Chrome serves a top-level PDF with an EMPTY body and no <embed> at all, so
  // content type is the only honest signal. Checking for embed[type=...] alone
  // silently disabled dark mode on every ?file=x.pdf endpoint.
  const r = inject({
    href: "https://example.com/download?file=report.pdf",
    state: legacyUserState(),
    contentType: "application/pdf",
  });
  assert.ok(r.overlay(), "a real PDF document should be darkened");
  assert.ok(r.dock(), "and it should get the floating dock");
});

check("an ambiguous URL paints when a PDF is embedded in an HTML page", () => {
  const r = inject({
    href: "https://example.com/download?file=report.pdf",
    state: legacyUserState(),
    embeds: ["embed"],
  });
  assert.ok(r.overlay(), "an embedded PDF viewer should be darkened");
});

check("a pdf.js canvas viewer is still recognised", () => {
  // pdf.js paints into <canvas>: no embed, content type text/html. The old build
  // darkened these purely from the URL, so dropping them would be a regression.
  const r = inject({
    href: "https://example.com/read?doc=thesis.pdf",
    state: legacyUserState(),
    embeds: ["pdfjs"],
  });
  assert.ok(r.overlay(), "pdf.js viewers must still darken");
});

check("sepia adds the tint for a Pro user", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState({
      mode: "sepia",
      billing: { ...legacyUserState().billing, status: "active", plan: "lifetime" },
    }),
  });
  assert.ok(r.overlay());
  assert.ok(r.tint(), "sepia must add the multiply tint layer");
});

check("free users never get sepia even if it is stored", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState({ mode: "sepia" }),
  });
  assert.ok(r.overlay());
  assert.equal(r.tint(), null, "sepia is Pro-only");
});

check("re-injection does not duplicate layers or docks", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState(),
    preloadedCore: true,
  });
  const darkLayers = r.body.children.filter((c) => c.id === "darkDiv");
  const docks = r.body.children.filter((c) => c.id === "pdfDarkModeDock");
  assert.equal(darkLayers.length, 1, "exactly one dark layer");
  assert.equal(docks.length, 1, "exactly one dock");
});

check("the dock toggle turns the page overlay off and back on", () => {
  const r = inject({ href: "https://arxiv.org/pdf/a.pdf", state: legacyUserState() });
  const dock = r.dock();
  const button = dock.find("pdfDarkModeToggle");
  assert.ok(button, "dock must contain the toggle button");

  button.click();
  assert.equal(r.overlay(), null, "clicking the dock should remove the overlay");
  assert.equal(button.textContent, "Dark mode: Off");

  button.click();
  assert.ok(r.overlay(), "clicking again should bring it back");
  assert.equal(button.textContent, "Dark mode: On");
});

check("the dock full dark button sends open-viewer with replaceTab setting", () => {
  const rReplace = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState({ replaceOriginalTab: true }),
  });
  const btnReplace = rReplace.dock().find("pdfDarkModeViewer");
  assert.ok(btnReplace, "dock must have full dark viewer button");
  btnReplace.click();
  assert.equal(rReplace.messages.length, 1);
  assert.equal(rReplace.messages[0].type, "open-viewer");
  assert.equal(rReplace.messages[0].pdfUrl, "https://arxiv.org/pdf/a.pdf");
  assert.equal(rReplace.messages[0].replaceTab, true);
  assert.equal(rReplace.openedWindows.length, 0, "must not open window when replaceOriginalTab is true");

  const rNewTab = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState({ replaceOriginalTab: false }),
  });
  const btnNewTab = rNewTab.dock().find("pdfDarkModeViewer");
  btnNewTab.click();
  assert.equal(rNewTab.messages.length, 1);
  assert.equal(rNewTab.messages[0].type, "open-viewer");
  assert.equal(rNewTab.messages[0].pdfUrl, "https://arxiv.org/pdf/a.pdf");
  assert.equal(rNewTab.messages[0].replaceTab, false);
});

check("the dock toggle persists page state to sessionStorage across tab reloads", () => {
  const sharedSession = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
  };
  const r1 = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState(),
    sessionStorage: sharedSession,
  });
  const btn = r1.dock().find("pdfDarkModeToggle");
  btn.click();
  assert.equal(r1.overlay(), null, "toggled off");
  assert.equal(sharedSession.getItem("__pdm_page_enabled"), "false");

  // Simulates reload/restoration where window in-memory state was wiped but sessionStorage survived
  const r2 = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState(),
    sessionStorage: sharedSession,
  });
  assert.equal(r2.overlay(), null, "restored tab must respect persisted off state");
});

check("visibilitychange event re-renders the overlay if missing", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState(),
  });
  assert.ok(r.overlay(), "initially dark");
  // Simulate native PDF plugin tearing down or clearing overlay while tab was hidden
  r.overlay().remove();
  assert.equal(r.overlay(), null, "removed while in background");
  // Tab becomes visible again
  r.context.document.visibilityState = "visible";
  r.triggerEvent("visibilitychange");
  assert.ok(r.overlay(), "overlay restored on visibilitychange");
});

check("extension context invalidation during background reload does not throw uncaught errors", () => {
  const r = inject({
    href: "https://arxiv.org/pdf/a.pdf",
    state: legacyUserState(),
  });
  assert.ok(r.overlay(), "initially dark");

  // Invalidate extension runtime context (as Chrome does when reloading in background)
  r.context.chrome.runtime = {
    get id() { throw new Error("Extension context invalidated."); },
    getURL() { throw new Error("Extension context invalidated."); },
    sendMessage() { throw new Error("Extension context invalidated."); },
  };
  r.context.chrome.storage = {
    sync: {
      get() { throw new Error("Extension context invalidated."); },
    },
  };

  // Tab visibilitychange event when context is dead must not throw
  assert.doesNotThrow(() => {
    r.context.document.visibilityState = "visible";
    r.triggerEvent("visibilitychange");
  });

  // Dock buttons click when context is dead must not throw AND must toggle the overlay
  const toggleBtn = r.dock().find("pdfDarkModeToggle");
  assert.doesNotThrow(() => {
    toggleBtn.click();
  });
  assert.equal(r.overlay(), null, "toggling dark mode when context is dead must still toggle overlay off");

  assert.doesNotThrow(() => {
    toggleBtn.click();
  });
  assert.ok(r.overlay(), "clicking again must toggle overlay back on");

  const viewerBtn = r.dock().find("pdfDarkModeViewer");
  assert.doesNotThrow(() => {
    viewerBtn.click();
  });
  assert.equal(r.openedWindows.length, 1, "viewer button must open fallback window when context is dead");
});

console.log(`content-smoke: ${passed} scenarios passed`);
