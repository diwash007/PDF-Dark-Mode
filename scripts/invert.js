/*
 * Content script. Injected as ["scripts/core.js", "scripts/invert.js"], so
 * PDFDarkModeCore is already defined by the time this runs.
 *
 * Can be injected into the same page many times (tab update, popup change,
 * keyboard shortcut, settings sync), so everything here is idempotent.
 */

(() => {
  const core = globalThis.PDFDarkModeCore;
  if (!core) {
    console.error("PDF Dark Mode: core module missing, refusing to run");
    return;
  }

  const ACTION_DOCK_ID = "pdfDarkModeDock";
  const TOGGLE_BUTTON_ID = "pdfDarkModeToggle";
  const INFO_BUTTON_ID = "pdfDarkModeInfo";
  const VIEWER_BUTTON_ID = "pdfDarkModeViewer";
  const PAGE_ENABLED_KEY = "__pdm_page_enabled";

  /* How long to keep watching for a PDF to appear on an ambiguous HTML page. */
  const EMBED_WATCH_MS = 10000;
  const EMBED_DEBOUNCE_MS = 120;

  const href = window.location.href;
  let currentSettings = {};

  // The full-dark viewer renders its own dark pages — never overlay or dock it.
  if (core.isViewerUrl && core.isViewerUrl(href)) return;

  const SETTINGS_KEYS = [
    "active",
    "strength",
    "contrast",
    "mode",
    "siteRules",
    "billing",
    "overlayAreaSettings",
    "siteOverlayAreas",
    "showDock",
    "replaceOriginalTab",
  ];

  function isContextAlive() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime) return false;
      if ("id" in chrome.runtime) {
        return Boolean(chrome.runtime.id);
      }
      return Boolean(chrome.runtime.getURL || chrome.runtime.sendMessage);
    } catch {
      return false;
    }
  }

  function safeStorageGet(keys, callback) {
    if (!isContextAlive()) return;
    try {
      chrome.storage.sync.get(keys, (res) => {
        try {
          if (chrome.runtime?.lastError) return;
          callback(res);
        } catch {
          /* context invalidated during callback */
        }
      });
    } catch {
      /* context invalidated synchronously */
    }
  }

  function safeSendMessage(message, callback) {
    if (!isContextAlive()) return;
    try {
      chrome.runtime.sendMessage(message, (res) => {
        try {
          if (chrome.runtime?.lastError) return;
          if (typeof callback === "function") callback(res);
        } catch {
          /* context invalidated during callback */
        }
      });
    } catch {
      /* context invalidated synchronously */
    }
  }

  let baseExtensionUrl = "";
  try {
    baseExtensionUrl = (chrome.runtime?.getURL && chrome.runtime.getURL("")) || "";
  } catch {
    baseExtensionUrl = "";
  }

  function safeGetURL(path) {
    try {
      if (chrome.runtime?.getURL) {
        const u = chrome.runtime.getURL(path);
        if (u) return u;
      }
    } catch {
      /* ignore */
    }
    if (baseExtensionUrl) {
      return baseExtensionUrl + (path.startsWith("/") ? path.slice(1) : path);
    }
    return "";
  }

  safeStorageGet(SETTINGS_KEYS, (state) => {
    render(state);
  });

  function render(state) {
    currentSettings = state || {};
    const entitlement = core.getEntitlement(state.billing);
    const policy = core.buildPolicy(href, state.siteRules || {}, entitlement);
    const isPdf = policy.requiresPdfEmbed ? core.isPdfDocument() : false;

    const visible = core.shouldPaint({
      shouldInject: policy.shouldInject,
      requiresPdfEmbed: policy.requiresPdfEmbed,
      active: state.active !== false,
      pageEnabled: isPageEnabled(),
      isPdf,
    });

    if (!visible) {
      core.removeOverlay();

      // The URL mentions a PDF but no viewer is on the page yet — it may still be
      // loading. Watch briefly rather than giving up or darkening blindly.
      if (policy.shouldInject && policy.requiresPdfEmbed && !isPdf && state.active !== false) {
        watchForEmbed();
      }

      // Keep the dock while the page is merely toggled off, so the user can turn
      // it back on; drop it entirely when this is not a PDF or the extension is off.
      const dockStillUseful =
        policy.shouldInject && state.active !== false && (!policy.requiresPdfEmbed || isPdf);
      installDock(dockStillUseful && state.showDock !== false);
      return;
    }

    paint(state, entitlement);
    installDock(state.showDock !== false);
  }

  function paint(state, entitlement) {
    const hostname = core.getHostnameFromUrl(href);
    const siteAreas = state.siteOverlayAreas || {};
    const area =
      entitlement.isPro && hostname && siteAreas[hostname]
        ? siteAreas[hostname]
        : state.overlayAreaSettings;

    core.paintOverlay(
      core.buildOverlayStyles({
        mode: state.mode,
        strength: state.strength,
        contrast: state.contrast,
        area,
        isPro: entitlement.isPro,
      })
    );
  }

  /* ------------------------------------------------------- embed watching */

  function watchForEmbed() {
    if (window.__pdfDarkModeEmbedWatcher) return;

    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!core.isPdfDocument()) return;
        stop();
        safeStorageGet(SETTINGS_KEYS, (fresh) => {
          render(fresh);
        });
      }, EMBED_DEBOUNCE_MS);
    });

    function stop() {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      clearTimeout(giveUp);
      window.__pdfDarkModeEmbedWatcher = null;
    }

    const giveUp = setTimeout(stop, EMBED_WATCH_MS);
    window.__pdfDarkModeEmbedWatcher = stop;

    const root = document.documentElement || document.body;
    if (!root) {
      stop();
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------ page state */

  function isPageEnabled() {
    if (window.__pdfDarkModePageEnabled !== undefined) {
      return window.__pdfDarkModePageEnabled !== false;
    }
    try {
      const storage =
        (typeof window !== "undefined" && window.sessionStorage) ||
        (typeof sessionStorage !== "undefined" ? sessionStorage : null);
      if (storage?.getItem) {
        const stored = storage.getItem(PAGE_ENABLED_KEY);
        if (stored !== null) return stored === "true";
      }
    } catch {
      /* ignore */
    }
    return true;
  }

  function setPageEnabled(enabled) {
    window.__pdfDarkModePageEnabled = !!enabled;
    try {
      const storage =
        (typeof window !== "undefined" && window.sessionStorage) ||
        (typeof sessionStorage !== "undefined" ? sessionStorage : null);
      if (storage?.setItem) {
        storage.setItem(PAGE_ENABLED_KEY, String(!!enabled));
      }
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------- tab lifecycle */

  function handleVisibilityOrFocus() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    safeStorageGet(SETTINGS_KEYS, (fresh) => {
      render(fresh);
    });
  }

  if (!window.__pdfDarkModeVisibilityBound) {
    window.__pdfDarkModeVisibilityBound = true;
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", handleVisibilityOrFocus);
    }
  }

  /* ------------------------------------------------------------- floating dock */

  function removeDock() {
    const existing = document.getElementById(ACTION_DOCK_ID);
    if (existing) existing.remove();
  }

  function installDock(shouldShow) {
    if (!shouldShow) {
      removeDock();
      return;
    }

    const existing = document.getElementById(ACTION_DOCK_ID);
    if (existing) {
      existing.remove();
    }

    if (!document.body) return;

    const dock = document.createElement("div");
    dock.id = ACTION_DOCK_ID;
    dock.setAttribute(
      "style",
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
        "display:flex;flex-direction:column;align-items:flex-end;gap:8px;"
    );

    const buttonStyle =
      "border:1px solid rgba(255,255,255,0.18);border-radius:999px;" +
      "background:rgba(17,24,39,0.92);color:#f9fafb;cursor:pointer;" +
      "box-shadow:0 6px 18px rgba(0,0,0,0.18);" +
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    const infoButton = document.createElement("button");
    infoButton.id = INFO_BUTTON_ID;
    infoButton.type = "button";
    infoButton.title = "Open PDF Dark Mode";
    infoButton.setAttribute("aria-label", "Open PDF Dark Mode settings");
    infoButton.textContent = "i";
    infoButton.setAttribute(
      "style",
      buttonStyle + "width:28px;height:28px;padding:0;font-size:14px;font-weight:700;line-height:1;"
    );
    infoButton.addEventListener("click", openPopupFromPage);

    const viewerButton = document.createElement("button");
    viewerButton.id = VIEWER_BUTTON_ID;
    viewerButton.type = "button";
    viewerButton.title = "Open this PDF in the full dark viewer";
    viewerButton.setAttribute("aria-label", "Open this PDF in the full dark viewer (new)");
    viewerButton.textContent = "Full dark ";
    const newBadge = document.createElement("span");
    newBadge.textContent = "NEW";
    newBadge.setAttribute(
      "style",
      "display:inline-block;margin-left:2px;padding:1px 6px;border-radius:999px;" +
        "background:#2a903b;color:#fff;font-size:10px;font-weight:800;line-height:1.4;" +
        "vertical-align:1px;"
    );
    viewerButton.appendChild(newBadge);
    viewerButton.setAttribute(
      "style",
      buttonStyle +
        "padding:8px 12px;font-size:12px;font-weight:600;line-height:1.2;" +
        "border-color:rgba(42,144,59,0.8);box-shadow:0 6px 18px rgba(0,0,0,0.18),0 0 0 1px rgba(42,144,59,0.45);"
    );
    viewerButton.addEventListener("click", openFullDarkViewer);

    const toggleButton = document.createElement("button");
    toggleButton.id = TOGGLE_BUTTON_ID;
    toggleButton.type = "button";
    toggleButton.title = "Toggle dark mode on this page";
    toggleButton.setAttribute(
      "style",
      buttonStyle + "padding:8px 12px;font-size:12px;font-weight:600;line-height:1.2;"
    );
    syncToggleLabel(toggleButton);

    toggleButton.addEventListener("click", () => {
      setPageEnabled(!isPageEnabled());
      syncToggleLabel(toggleButton);
      safeSendMessage({ type: "analytics-event", event: "pageToggle" });
      if (isContextAlive()) {
        safeStorageGet(SETTINGS_KEYS, (state) => {
          render(state);
        });
      } else {
        render(currentSettings);
      }
    });

    dock.appendChild(infoButton);
    dock.appendChild(viewerButton);
    dock.appendChild(toggleButton);
    document.body.appendChild(dock);
  }

  function syncToggleLabel(button) {
    if (!button) return;
    const enabled = isPageEnabled();
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "Dark mode: On" : "Dark mode: Off";
  }

  function openPopupFromPage() {
    // chrome.action.openPopup can fail (e.g. no active window); opening the
    // popup page in a tab via the worker is the fallback. window.open is only
    // the last resort — shield/popup blockers eat it (Brave:
    // ERR_BLOCKED_BY_CLIENT).
    const windowFallback = () => {
      const popupUrl = safeGetURL("popup/popup.html");
      if (popupUrl) {
        window.open(popupUrl, "_blank", "noopener,noreferrer");
      }
    };

    const openTabFallback = () => {
      safeSendMessage({ type: "open-popup-tab" }, (response) => {
        if (!response?.ok) windowFallback();
      });
    };

    safeSendMessage({ type: "open-popup" }, (response) => {
      if (!response?.ok) openTabFallback();
    });
  }

  function openFullDarkViewer() {
    // window.open from the page is eaten by popup/shield blockers (Brave
    // shows ERR_BLOCKED_BY_CLIENT), so the service worker opens the tab via
    // chrome.tabs.create or chrome.tabs.update — the same path the popup button uses.
    const viewerUrl = safeGetURL(
      "viewer/viewer.html?pdf=" + encodeURIComponent(window.location.href)
    );
    if (!viewerUrl) return;

    if (!isContextAlive()) {
      window.open(viewerUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const executeOpen = (replaceTab) => {
      if (!isContextAlive() || !globalThis.chrome?.runtime?.sendMessage) {
        if (!replaceTab && viewerUrl) {
          window.open(viewerUrl, "_blank", "noopener,noreferrer");
        }
        return;
      }

      safeSendMessage(
        { type: "open-viewer", pdfUrl: window.location.href, replaceTab },
        (response) => {
          if (!replaceTab && !response?.ok) {
            if (viewerUrl) window.open(viewerUrl, "_blank", "noopener,noreferrer");
          }
        }
      );
    };

    if (typeof currentSettings?.replaceOriginalTab === "boolean") {
      executeOpen(currentSettings.replaceOriginalTab);
    } else {
      safeStorageGet(["replaceOriginalTab"], (res) => {
        executeOpen(Boolean(res?.replaceOriginalTab));
      });
    }
  }
})();
