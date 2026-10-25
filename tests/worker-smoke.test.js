/*
 * Executes worker.js in a stubbed service-worker environment and drives its
 * listeners, so the injection decisions are tested as behaviour rather than
 * by reading the source.
 *
 * Run: node tests/worker-smoke.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const coreSrc = fs.readFileSync(path.join(root, "scripts/core.js"), "utf8");
const workerSrc = fs.readFileSync(path.join(root, "worker.js"), "utf8");

function boot({
  syncState = {},
  fileAccess = null,
  licenseResponse = null,
  localState = {},
  tabPropsById = {},
} = {}) {
  const calls = {
    executeScript: [],
    syncWrites: [],
    localWrites: [],
    tabsCreated: [],
    tabsUpdated: [],
    tabsQueried: 0,
    badgeTexts: [],
    badgeColors: [],
    alarmsCreated: [],
    fetches: [],
  };

  const listeners = {};
  const register = (name) => ({
    addListener: (fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
  });

  const store = { ...syncState };
  const localStore = { analytics: { events: {}, pdfAppliesByDay: {} }, ...localState };

  const chromeStub = {
    runtime: {
      id: "test-id",
      lastError: null,
      getManifest: () => ({ version: "2.2.0" }),
      getURL: (pagePath) => `chrome-extension://test-id/${pagePath}`,
      OnInstalledReason: { INSTALL: "install", UPDATE: "update" },
      onInstalled: register("onInstalled"),
      onStartup: register("onStartup"),
      onMessage: register("onMessage"),
    },
    extension:
      fileAccess === null
        ? undefined
        : { isAllowedFileSchemeAccess: (cb) => cb(fileAccess) },
    action: {
      openPopup: () => Promise.resolve(),
      setBadgeText: (opts) => {
        calls.badgeTexts.push(opts);
        return Promise.resolve();
      },
      setBadgeBackgroundColor: (opts) => {
        calls.badgeColors.push(opts);
        return Promise.resolve();
      },
    },
    tabs: {
      onUpdated: register("onUpdated"),
      onActivated: register("onActivated"),
      onRemoved: register("onRemoved"),
      create: (opts, cb) => {
        calls.tabsCreated.push(opts);
        if (typeof cb === "function") cb();
        return Promise.resolve({});
      },
      update: (tabId, opts, cb) => {
        calls.tabsUpdated.push({ tabId, opts });
        if (typeof cb === "function") cb();
        return Promise.resolve({});
      },
      get: (tabId, cb) => {
        const tab = tabPropsById[tabId]
          ? { id: tabId, ...tabPropsById[tabId] }
          : tabId === 21
          ? { id: 21, url: "file:///Users/me/reading/thesis.pdf" }
          : { id: tabId, url: "https://example.com/" };
        if (typeof cb === "function") return cb(tab);
        return Promise.resolve(tab);
      },
      query: () => {
        calls.tabsQueried += 1;
        return Promise.resolve([
          { id: 11, url: "https://arxiv.org/pdf/a.pdf" },
          { id: 12, url: "https://example.com/" },
        ]);
      },
    },
    storage: {
      // MV3 storage supports both a callback and a promise; the worker uses
      // each in different places, so the stub has to honour both.
      sync: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          if (typeof cb === "function") return cb(out);
          return Promise.resolve(out);
        },
        set: (items, cb) => {
          Object.assign(store, items);
          calls.syncWrites.push(items);
          if (typeof cb === "function") return cb();
          return Promise.resolve();
        },
      },
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => {
            if (k in localStore) out[k] = localStore[k];
          });
          if (typeof cb === "function") return cb(out);
          return Promise.resolve(out);
        },
        set: (items, cb) => {
          Object.assign(localStore, items);
          calls.localWrites.push(items);
          if (typeof cb === "function") return cb();
          return Promise.resolve();
        },
      },
      onChanged: register("onChanged"),
    },
    scripting: {
      executeScript: (opts) => {
        calls.executeScript.push(opts);
        return Promise.resolve([]);
      },
    },
    alarms: {
      get: (name, cb) => cb(null),
      create: (name, opts) => calls.alarmsCreated.push({ name, opts }),
      onAlarm: register("onAlarm"),
    },
    commands: { onCommand: register("onCommand") },
  };

  const context = {
    chrome: chromeStub,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout,
    clearTimeout,
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
    Error,
    TypeError,
    crypto: { randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    AbortSignal: { timeout: () => ({}) },
    fetch: (url, init) => {
      calls.fetches.push({ url, init });
      const body = licenseResponse !== null ? licenseResponse : { valid: true };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    },
    importScripts: () => {
      new vm.Script(coreSrc, { filename: "scripts/core.js" }).runInContext(context);
    },
  };
  context.globalThis = context;
  vm.createContext(context);

  new vm.Script(workerSrc, { filename: "worker.js" }).runInContext(context);

  const fire = (name, ...args) =>
    Promise.all((listeners[name] || []).map((fn) => fn(...args)));

  return { calls, fire, listeners, store, context };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  /* ------------------------------------------------ boots and registers */

  {
    const { listeners, context } = boot();
    assert.ok(context.PDFDarkModeCore, "worker must importScripts core.js");
    ["onUpdated", "onActivated", "onRemoved", "onInstalled", "onStartup", "onMessage", "onAlarm", "onCommand", "onChanged"].forEach(
      (name) => assert.ok(listeners[name]?.length, `missing listener: ${name}`)
    );
  }

  /* ------------------------------------------------------ tab injection */

  {
    const { calls, fire } = boot({ syncState: { active: true, siteRules: {} } });
    await fire("onUpdated", 5, { status: "complete" }, { url: "https://arxiv.org/pdf/a.pdf" });
    await settle();

    assert.equal(calls.executeScript.length, 1, "a real PDF should be injected");
    // Array.from: the VM has its own realm, so its arrays fail a strict
    // prototype comparison against host arrays.
    assert.deepEqual(
      Array.from(calls.executeScript[0].files),
      ["scripts/core.js", "scripts/invert.js"],
      "core must be injected alongside the content script"
    );
  }

  {
    const { calls, fire } = boot({ syncState: { active: true, siteRules: {} } });
    await fire("onUpdated", 5, { status: "complete" }, { url: "https://example.com/" });
    await settle();
    assert.equal(calls.executeScript.length, 0, "ordinary pages must be left alone");
  }

  {
    // Regression: this URL matched the old whole-URL regex and went dark.
    const { calls, fire } = boot({ syncState: { active: true, siteRules: {} } });
    await fire(
      "onUpdated",
      5,
      { status: "complete" },
      { url: "https://www.google.com/search?q=report.pdf&hl=en" }
    );
    await settle();

    assert.equal(
      calls.executeScript.length,
      1,
      "ambiguous URLs are still injected so the DOM can be inspected"
    );
    const counted = calls.localWrites.some((w) => w.analytics?.events?.pdfApplies);
    assert.equal(counted, false, "an unconfirmed PDF must not count as a reading session");
  }

  {
    const { calls, fire } = boot({ syncState: { active: false, siteRules: {} } });
    await fire("onUpdated", 5, { status: "complete" }, { url: "https://arxiv.org/pdf/a.pdf" });
    await settle();
    assert.equal(calls.executeScript.length, 0, "nothing should inject while switched off");
  }

  /* ------------------------------------------------- keyboard shortcut */

  {
    // The headline bug: this used to write active:false and then repaint.
    const { calls, fire, store } = boot({ syncState: { active: true } });
    await fire("onCommand", "run-dark-mode");
    await settle();

    assert.equal(store.active, false, "shortcut must switch the extension off");
    assert.ok(
      calls.syncWrites.some((w) => w.active === false),
      "shortcut must persist active:false"
    );
  }

  {
    const { store, fire } = boot({ syncState: { active: false } });
    await fire("onCommand", "run-dark-mode");
    await settle();
    assert.equal(store.active, true, "shortcut must switch it back on");
  }

  {
    // Fresh install: `active` is undefined but defaults to on, so the first
    // press must turn it off rather than being swallowed.
    const { store, fire } = boot({ syncState: {} });
    await fire("onCommand", "run-dark-mode");
    await settle();
    assert.equal(store.active, false, "first press on a fresh profile must switch off");
  }

  /* ------------------------------------------------- viewer tab opening */

  {
    // The on-page dock has no chrome.tabs and window.open trips shield/popup
    // blockers (Brave: ERR_BLOCKED_BY_CLIENT), so it asks the worker to open
    // the viewer tab — the same chrome.tabs.create path the popup uses.
    const { calls, fire } = boot({ syncState: {} });
    let response = null;
    await fire("onMessage", { type: "open-viewer", pdfUrl: "https://arxiv.org/pdf/a.pdf" }, {}, (r) => {
      response = r;
    });
    await settle();

    assert.equal(response?.ok, true, "open-viewer must succeed for a PDF URL");
    assert.equal(calls.tabsCreated.length, 1, "open-viewer must open exactly one tab");
    assert.equal(
      calls.tabsCreated[0].url,
      "chrome-extension://test-id/viewer/viewer.html?pdf=" +
        encodeURIComponent("https://arxiv.org/pdf/a.pdf"),
      "viewer tab must carry the encoded PDF URL"
    );
  }

  {
    const { calls, fire } = boot({ syncState: {} });
    let response = null;
    await fire("onMessage", { type: "open-viewer", pdfUrl: "javascript:alert(1)" }, {}, (r) => {
      response = r;
    });
    await settle();

    assert.equal(response?.ok, false, "open-viewer must refuse non-pdf schemes");
    assert.equal(calls.tabsCreated.length, 0, "refused URLs must not open a tab");
  }

  {
    // When replaceOriginalTab is enabled, open-viewer replaces the existing tab
    const { calls, fire } = boot({ syncState: { replaceOriginalTab: true } });
    let response = null;
    await fire(
      "onMessage",
      { type: "open-viewer", pdfUrl: "https://arxiv.org/pdf/a.pdf", tabId: 42 },
      {},
      (r) => { response = r; }
    );
    await settle();

    assert.equal(response?.ok, true, "open-viewer must succeed in replace mode");
    assert.equal(calls.tabsCreated.length, 0, "must not create a new tab when replaceOriginalTab is on");
    assert.equal(calls.tabsUpdated.length, 1, "must update the existing tab");
    assert.equal(calls.tabsUpdated[0].tabId, 42);
    assert.equal(
      calls.tabsUpdated[0].opts.url,
      "chrome-extension://test-id/viewer/viewer.html?pdf=" +
        encodeURIComponent("https://arxiv.org/pdf/a.pdf")
    );
  }

  {
    // When replaceOriginalTab is enabled and tabId comes from sender tab
    const { calls, fire } = boot({ syncState: { replaceOriginalTab: true } });
    let response = null;
    await fire(
      "onMessage",
      { type: "open-viewer", pdfUrl: "https://arxiv.org/pdf/a.pdf" },
      { tab: { id: 77 } },
      (r) => { response = r; }
    );
    await settle();

    assert.equal(response?.ok, true);
    assert.equal(calls.tabsCreated.length, 0);
    assert.equal(calls.tabsUpdated.length, 1);
    assert.equal(calls.tabsUpdated[0].tabId, 77);
  }

  {
    // When replaceOriginalTab is false, create tab is used even with tabId
    const { calls, fire } = boot({ syncState: { replaceOriginalTab: false } });
    let response = null;
    await fire(
      "onMessage",
      { type: "open-viewer", pdfUrl: "https://arxiv.org/pdf/a.pdf", tabId: 42 },
      {},
      (r) => { response = r; }
    );
    await settle();

    assert.equal(response?.ok, true);
    assert.equal(calls.tabsCreated.length, 1, "must create tab when replaceOriginalTab is false");
    assert.equal(calls.tabsUpdated.length, 0);
  }

  {
    // Explicit replaceTab in message takes precedence over syncState
    const { calls, fire } = boot({ syncState: { replaceOriginalTab: false } });
    let response = null;
    await fire(
      "onMessage",
      { type: "open-viewer", pdfUrl: "https://arxiv.org/pdf/a.pdf", tabId: 99, replaceTab: true },
      {},
      (r) => { response = r; }
    );
    await settle();

    assert.equal(response?.ok, true);
    assert.equal(calls.tabsCreated.length, 0);
    assert.equal(calls.tabsUpdated.length, 1);
    assert.equal(calls.tabsUpdated[0].tabId, 99);
  }

  {
    // Falls back to querying active tab when tabId and sender tab are missing
    const { calls, fire } = boot({ syncState: { replaceOriginalTab: true } });
    let response = null;
    await fire(
      "onMessage",
      { type: "open-viewer", pdfUrl: "https://arxiv.org/pdf/a.pdf" },
      {},
      (r) => { response = r; }
    );
    await settle();

    assert.equal(response?.ok, true);
    assert.equal(calls.tabsCreated.length, 0);
    assert.equal(calls.tabsUpdated.length, 1);
    assert.equal(calls.tabsUpdated[0].tabId, 11, "queries active tab 11");
  }

  {
    // Popup fallback when chrome.action.openPopup fails: the popup page
    // opens in a tab instead of window.open (shield-blocked in Brave).
    const { calls, fire } = boot({ syncState: {} });
    let response = null;
    await fire("onMessage", { type: "open-popup-tab" }, {}, (r) => {
      response = r;
    });
    await settle();

    assert.equal(response?.ok, true, "open-popup-tab must succeed");
    assert.equal(calls.tabsCreated.length, 1, "open-popup-tab must open exactly one tab");
    assert.equal(
      calls.tabsCreated[0].url,
      "chrome-extension://test-id/popup/popup.html",
      "popup tab must point at the popup page"
    );
  }

  {
    const { calls, fire } = boot({ syncState: {} });
    let response = null;
    await fire("onMessage", { type: "open-extension-settings" }, {}, (r) => {
      response = r;
    });
    await settle();

    assert.equal(response?.ok, true, "open-extension-settings must succeed");
    assert.equal(
      calls.tabsCreated[0]?.url,
      "chrome://extensions/?id=test-id",
      "settings tab must point at this extension's details page"
    );
  }

  /* ------------------------------------------------- file access badge */

  {
    // file:// tab without access: badge warns. Content scripts never run
    // there, so the badge is the only in-browser signal (plus the popup).
    const { calls, fire } = boot({ syncState: {}, fileAccess: false });
    await fire("onUpdated", 21, { status: "complete" }, { url: "file:///Users/me/reading/thesis.pdf" });
    await settle();

    assert.ok(
      calls.badgeTexts.some((b) => b.text === "!" && b.tabId === 21),
      "file tab without access must show the ! badge"
    );
  }

  {
    const { calls, fire } = boot({ syncState: {}, fileAccess: true });
    await fire("onUpdated", 21, { status: "complete" }, { url: "file:///Users/me/reading/thesis.pdf" });
    await settle();

    assert.ok(
      calls.badgeTexts.every((b) => b.text !== "!"),
      "file tab with access must never show the ! badge"
    );
  }

  {
    // Ordinary pages never touch the badge; missing file-access API never throws.
    const { calls, fire } = boot({ syncState: {} });
    await fire("onUpdated", 5, { status: "complete" }, { url: "https://arxiv.org/pdf/a.pdf" });
    await settle();
    assert.ok(
      calls.badgeTexts.every((b) => b.text !== "!"),
      "non-file tabs must never show the ! badge"
    );

    const noApi = boot({ syncState: {}, fileAccess: null });
    await noApi.fire("onUpdated", 21, { status: "complete" }, { url: "file:///x.pdf" });
    await settle();
    assert.equal(noApi.calls.badgeTexts.filter((b) => b.text === "!").length, 0);
  }

  {
    // Switching to an already-open file:// tab re-evaluates the badge.
    const { calls, fire } = boot({ syncState: {}, fileAccess: false });
    await fire("onActivated", { tabId: 21 });
    await settle();

    assert.ok(
      calls.badgeTexts.some((b) => b.text === "!" && b.tabId === 21),
      "activating a file tab without access must show the ! badge"
    );
  }

  /* --------------------------------------- license browser tagging */

  {
    // The popup's detected browser rides into the Lemon instance name, so
    // Pro usage splits by browser in the dashboard.
    const { calls, fire, store } = boot({
      syncState: {},
      licenseResponse: { instance_id: "inst-1", valid: true },
    });
    let response = null;
    await fire(
      "onMessage",
      { type: "license-activate", licenseKey: "test-key-1234", browser: "brave-macos" },
      {},
      (r) => {
        response = r;
      }
    );
    await settle();
    await settle();

    assert.equal(response?.ok, true, "activation must succeed");
    const activateCall = calls.fetches.find((f) => /\/activate$/.test(f.url));
    const sentName = JSON.parse(activateCall.init.body).instance_name;
    assert.match(
      sentName,
      /^pdf-dark-mode-brave-macos-[a-z0-9]+$/,
      "instance name must carry the browser tag"
    );
    assert.equal(store.billing.browser, "brave-macos", "browser must persist on billing");
    assert.equal(store.billing.instanceName, sentName, "stored name must match the sent name");
  }

  {
    // Hostile or missing browser tags never reach the network or storage
    // unfiltered — they fall back to unknown-unknown.
    for (const hostile of ["../../etc/x", "CHROME-WINDOWS", "", null, undefined, "x".repeat(500)]) {
      const { store, fire } = boot({
        syncState: {},
        licenseResponse: { instance_id: "inst-1", valid: true },
      });
      let response = null;
      await fire("onMessage", { type: "license-activate", licenseKey: "k", browser: hostile }, {}, (r) => {
        response = r;
      });
      await settle();
      await settle();

      assert.equal(response?.ok, true, `activation must survive browser=${JSON.stringify(hostile)}`);
      assert.match(
        store.billing.instanceName || "",
        hostile === "CHROME-WINDOWS" ? /^pdf-dark-mode-chrome-windows-/ : /^pdf-dark-mode-unknown-unknown-/,
        "case-normalized tags pass, everything else falls back"
      );
    }
  }

  /* --------------------------------------------------- live tab syncing */

  {
    const { calls, fire } = boot({ syncState: { active: true, siteRules: {} } });
    await fire("onChanged", { mode: { newValue: "sepia" } }, "sync");
    await settle();
    await settle();

    assert.ok(calls.tabsQueried > 0, "a setting change should fan out to open tabs");
    assert.equal(
      calls.executeScript.length,
      1,
      "only the open PDF tab should be re-rendered, not every tab"
    );
  }

  {
    const { calls, fire } = boot({ syncState: { active: true } });
    await fire("onChanged", { analytics: { newValue: {} } }, "local");
    await settle();
    assert.equal(calls.tabsQueried, 0, "local analytics writes must not trigger a fan-out");
  }

  /* ---------------------------------------------------------- defaults */

  {
    const { calls } = boot({ syncState: {} });
    await settle();
    const written = Object.assign({}, ...calls.syncWrites);
    assert.equal(written.active, true);
    assert.equal(written.showDock, true);
    assert.equal(written.strength, 255);
    assert.equal(written.mode, "dark");
  }

  {
    const { calls } = boot({
      syncState: { active: false, strength: 210, contrast: 90, mode: "sepia", siteRules: {}, showDock: false, billing: {} },
    });
    await settle();
    assert.equal(
      calls.syncWrites.length,
      0,
      "existing settings must never be overwritten by defaults"
    );
  }

  /* ------------------------------------- viewer session auto-restore on update */

  {
    const { calls, fire } = boot({
      syncState: {},
      localState: {
        activeViewerSessions: {
          "101": {
            pdfUrl: "file:///Users/diwash/Downloads/Green%20Book.pdf",
            page: 211,
            updatedAt: Date.now(),
          },
        },
      },
    });

    await fire("onInstalled", { reason: "update" });
    await settle();

    assert.equal(calls.tabsCreated.length, 1, "update must restore active viewer tab");
    assert.equal(
      calls.tabsCreated[0].url,
      "chrome-extension://test-id/viewer/viewer.html?pdf=" +
        encodeURIComponent("file:///Users/diwash/Downloads/Green%20Book.pdf") +
        "#page=211"
    );
  }

  {
    // When the viewer tab is still open in the browser during update, reload it in-place
    const { calls, fire } = boot({
      syncState: {},
      localState: {
        activeViewerSessions: {
          "105": {
            pdfUrl: "file:///Users/diwash/Downloads/Green%20Book.pdf",
            page: 42,
            windowId: 1,
            index: 2,
            updatedAt: Date.now(),
          },
        },
      },
      tabPropsById: {
        105: {
          url: "chrome-extension://test-id/viewer/viewer.html?pdf=foo",
          windowId: 1,
          index: 2,
        },
      },
    });

    await fire("onInstalled", { reason: "update" });
    await settle();

    assert.equal(calls.tabsCreated.length, 0, "must not spawn a new tab when tab is still open");
    assert.equal(calls.tabsUpdated.length, 1, "must update the existing tab in-place");
    assert.equal(calls.tabsUpdated[0].tabId, 105);
    assert.ok(calls.tabsUpdated[0].opts.url.includes("#page=42"));
  }

  {
    // When recreating a closed tab, restore it at its previous index and window
    const { calls, fire } = boot({
      syncState: {},
      localState: {
        activeViewerSessions: {
          "200": {
            pdfUrl: "https://arxiv.org/pdf/a.pdf",
            page: 1,
            windowId: 7,
            index: 4,
            active: true,
            updatedAt: Date.now(),
          },
        },
      },
    });

    await fire("onInstalled", { reason: "update" });
    await settle();

    assert.equal(calls.tabsCreated.length, 1);
    assert.equal(calls.tabsCreated[0].windowId, 7);
    assert.equal(calls.tabsCreated[0].index, 4);
    assert.equal(calls.tabsCreated[0].active, true);
  }

  {
    // Closing a viewer tab cleans up its stored session
    const { calls, fire } = boot({
      syncState: {},
      localState: {
        activeViewerSessions: {
          "101": {
            pdfUrl: "https://arxiv.org/pdf/a.pdf",
            page: 5,
            updatedAt: Date.now(),
          },
        },
      },
    });

    await fire("onRemoved", 101);
    await settle();

    const write = calls.localWrites.find((w) => "activeViewerSessions" in w);
    assert.ok(write, "removing tab must update activeViewerSessions in local storage");
    assert.equal(write.activeViewerSessions["101"], undefined, "closed tab session must be removed");
  }

  {
    // Switching to an already-open PDF tab ensures content script is injected
    const { calls, fire } = boot({
      syncState: { active: true },
      tabPropsById: {
        42: { id: 42, url: "https://arxiv.org/pdf/paper.pdf" },
        43: { id: 43, url: "https://example.com/not-a-pdf" },
      },
    });

    await fire("onActivated", { tabId: 42 });
    await settle();

    assert.ok(
      calls.executeScript.some((c) => c.target?.tabId === 42),
      "activating a PDF tab must ensure content script is injected"
    );

    // Non-PDF tab does not inject on activation
    await fire("onActivated", { tabId: 43 });
    await settle();

    assert.ok(
      !calls.executeScript.some((c) => c.target?.tabId === 43),
      "activating a non-PDF tab must not inject content script"
    );
  }

  console.log("worker-smoke: injection, shortcut toggle, fan-out and defaults all behave");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
