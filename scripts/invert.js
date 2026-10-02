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

  /* How long to keep watching for a PDF to appear on an ambiguous HTML page. */
  const EMBED_WATCH_MS = 10000;
  const EMBED_DEBOUNCE_MS = 120;

  const href = window.location.href;

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
  ];

  chrome.storage.sync.get(SETTINGS_KEYS, (state) => {
    if (chrome.runtime.lastError) return;
    render(state);
  });

  function render(state) {
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
        chrome.storage.sync.get(SETTINGS_KEYS, (fresh) => {
          if (chrome.runtime.lastError) return;
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
    return window.__pdfDarkModePageEnabled !== false;
  }

  function setPageEnabled(enabled) {
    window.__pdfDarkModePageEnabled = !!enabled;
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

    // Already present: just resync the label so a re-injection cannot leave it lying.
    const existing = document.getElementById(ACTION_DOCK_ID);
    if (existing) {
      syncToggleLabel(existing.querySelector(`#${TOGGLE_BUTTON_ID}`));
      return;
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
      chrome.runtime.sendMessage({ type: "analytics-event", event: "pageToggle" });
      chrome.storage.sync.get(SETTINGS_KEYS, (state) => {
        if (chrome.runtime.lastError) return;
        render(state);
      });
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
    const openTabFallback = () => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        windowFallback();
        return;
      }
      chrome.runtime.sendMessage({ type: "open-popup-tab" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) windowFallback();
      });
    };
    const windowFallback = () => {
      if (globalThis.chrome?.runtime?.getURL) {
        window.open(chrome.runtime.getURL("popup/popup.html"), "_blank", "noopener,noreferrer");
      }
    };

    if (!globalThis.chrome?.runtime?.sendMessage) {
      windowFallback();
      return;
    }

    chrome.runtime.sendMessage({ type: "open-popup" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) openTabFallback();
    });
  }

  function openFullDarkViewer() {
    // window.open from the page is eaten by popup/shield blockers (Brave
    // shows ERR_BLOCKED_BY_CLIENT), so the service worker opens the tab via
    // chrome.tabs.create — the same path the popup button uses.
    if (!globalThis.chrome?.runtime?.getURL) return;
    const viewerUrl = chrome.runtime.getURL(
      "viewer/viewer.html?pdf=" + encodeURIComponent(window.location.href)
    );

    if (!globalThis.chrome?.runtime?.sendMessage) {
      window.open(viewerUrl, "_blank", "noopener,noreferrer");
      return;
    }

    chrome.runtime.sendMessage(
      { type: "open-viewer", pdfUrl: window.location.href },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          window.open(viewerUrl, "_blank", "noopener,noreferrer");
        }
      }
    );
  }
})();
