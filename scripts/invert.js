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
  const ALIGN_BUTTON_ID = "pdfDarkModeAlign";

  /* How long to keep watching for a PDF to appear on an ambiguous HTML page. */
  const EMBED_WATCH_MS = 10000;
  const EMBED_DEBOUNCE_MS = 120;
  const MEASURE_DEBOUNCE_MS = 260;

  const BUTTON_STYLE =
    "border:1px solid rgba(255,255,255,0.18);border-radius:999px;" +
    "background:rgba(17,24,39,0.92);color:#f9fafb;cursor:pointer;" +
    "box-shadow:0 6px 18px rgba(0,0,0,0.18);" +
    'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  const href = window.location.href;

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
    "pageClip",
  ];

  /* Experimental page-clip state, per page. */
  let clipArea = null;        // detected insets, CSS px
  let measuring = false;
  let autoMeasureDone = false;
  let measureTimer = null;
  let measureAttempt = 0;
  let lastState = null;

  /*
   * Chrome's PDF viewer paints asynchronously and there is no event for "the
   * document is on screen". A measurement taken before the first paint sees an
   * empty grey viewer and finds no page, so retry a couple of times before
   * settling for the full-viewport overlay.
   */
  const MEASURE_RETRY_MS = [0, 700, 1600];

  readSettings(render);

  function readSettings(done) {
    chrome.storage.sync.get(SETTINGS_KEYS, (state) => {
      if (chrome.runtime.lastError) return;
      done(state);
    });
  }

  function render(state) {
    lastState = state;
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

      if (policy.shouldInject && policy.requiresPdfEmbed && !isPdf && state.active !== false) {
        watchForEmbed();
      }

      const dockStillUseful =
        policy.shouldInject && state.active !== false && (!policy.requiresPdfEmbed || isPdf);
      installDock(dockStillUseful && state.showDock !== false, state);
      return;
    }

    paint(state, entitlement);
    installDock(state.showDock !== false, state);

    if (state.pageClip === true) {
      installClipListeners();
      if (!autoMeasureDone && !measuring) scheduleMeasure(160);
    } else if (clipArea) {
      clipArea = null;
      paint(state, entitlement);
    }
  }

  function resolveArea(state, entitlement) {
    if (clipArea) return clipArea;
    const hostname = core.getHostnameFromUrl(href);
    const siteAreas = state.siteOverlayAreas || {};
    return entitlement.isPro && hostname && siteAreas[hostname]
      ? siteAreas[hostname]
      : state.overlayAreaSettings;
  }

  function paint(state, entitlement) {
    core.paintOverlay(
      core.buildOverlayStyles({
        mode: state.mode,
        strength: state.strength,
        contrast: state.contrast,
        area: resolveArea(state, entitlement),
        isPro: entitlement.isPro,
      })
    );
  }

  /* ------------------------------------------------- experimental page clip */

  function scheduleMeasure(delay) {
    if (!lastState || lastState.pageClip !== true) return;
    clearTimeout(measureTimer);
    measureTimer = setTimeout(runMeasure, typeof delay === "number" ? delay : MEASURE_DEBOUNCE_MS);
  }

  /*
   * Measure where the viewer is drawing the page, then clip the overlay to it.
   *
   * The overlay is reset to full-viewport for the capture so the worker can undo
   * the inversion arithmetically (difference-with-white is 255 - channel). That
   * means a re-measure briefly looks like the old full-page behaviour rather
   * than flashing a white page at the reader.
   */
  function runMeasure() {
    if (measuring || !lastState) return;
    if (document.visibilityState !== "visible") return;

    const entitlement = core.getEntitlement(lastState.billing);
    if (!document.getElementById(core.DARK_LAYER_ID)) return;

    measuring = true;
    const hadClip = !!clipArea;
    clipArea = null;
    if (hadClip) paint(lastState, entitlement);

    // Let the un-clipped overlay actually reach the screen before capturing.
    requestAnimationFrame(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage(
          {
            type: "measure-page-rect",
            inverted: true,
            dpr: window.devicePixelRatio || 1,
          },
          (response) => {
            measuring = false;
            if (chrome.runtime.lastError || !lastState) {
              autoMeasureDone = true;
              return;
            }

            const found =
              response && response.ok && response.insets && response.insets.confident
                ? response.insets
                : null;

            if (!found && measureAttempt < MEASURE_RETRY_MS.length - 1) {
              // Probably measured before the viewer finished painting.
              measureAttempt += 1;
              scheduleMeasure(MEASURE_RETRY_MS[measureAttempt]);
              return;
            }

            measureAttempt = 0;
            autoMeasureDone = true;
            clipArea = found;
            paint(lastState, core.getEntitlement(lastState.billing));
            flashAlignButton(!!clipArea);
          }
        );
      }, 32);
    });
  }

  function forceMeasure() {
    autoMeasureDone = false;
    measureAttempt = 0;
    scheduleMeasure(0);
  }

  function installClipListeners() {
    if (window.__pdfDarkModeClipListeners) return;
    window.__pdfDarkModeClipListeners = true;

    // Window resize is the only viewer-layout change that reaches us as an
    // event; the viewer's own zoom and sidebar toggle are silent, which is what
    // the re-align button is for.
    window.addEventListener("resize", () => {
      autoMeasureDone = false;
      measureAttempt = 0;
      scheduleMeasure();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      autoMeasureDone = false;
      measureAttempt = 0;
      scheduleMeasure(200);
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "page-clip-remeasure") forceMeasure();
    });
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
        readSettings(render);
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

  /* --------------------------------------------------------- floating dock */

  function removeDock() {
    const existing = document.getElementById(ACTION_DOCK_ID);
    if (existing) existing.remove();
  }

  function installDock(shouldShow, state) {
    if (!shouldShow) {
      removeDock();
      return;
    }

    const wantsAlign = state?.pageClip === true;
    const signature = wantsAlign ? "align" : "plain";
    const existing = document.getElementById(ACTION_DOCK_ID);

    if (existing) {
      // Rebuild only when the button set changed; otherwise just resync labels.
      if (existing.dataset.pdmSignature === signature) {
        syncToggleLabel(existing.querySelector(`#${TOGGLE_BUTTON_ID}`));
        return;
      }
      existing.remove();
    }

    if (!document.body) return;

    const dock = document.createElement("div");
    dock.id = ACTION_DOCK_ID;
    dock.dataset.pdmSignature = signature;
    dock.setAttribute(
      "style",
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
        "display:flex;flex-direction:column;align-items:flex-end;gap:8px;"
    );

    const infoButton = document.createElement("button");
    infoButton.id = INFO_BUTTON_ID;
    infoButton.type = "button";
    infoButton.title = "Open PDF Dark Mode";
    infoButton.setAttribute("aria-label", "Open PDF Dark Mode settings");
    infoButton.textContent = "i";
    infoButton.setAttribute(
      "style",
      BUTTON_STYLE + "width:28px;height:28px;padding:0;font-size:14px;font-weight:700;line-height:1;"
    );
    infoButton.addEventListener("click", openPopupFromPage);
    dock.appendChild(infoButton);

    if (wantsAlign) {
      const alignButton = document.createElement("button");
      alignButton.id = ALIGN_BUTTON_ID;
      alignButton.type = "button";
      alignButton.title =
        "Re-align dark mode to the page. Chrome does not tell extensions when " +
        "you zoom or open the sidebar, so this nudges it.";
      alignButton.textContent = "Re-align";
      alignButton.setAttribute(
        "style",
        BUTTON_STYLE + "padding:6px 11px;font-size:11px;font-weight:600;line-height:1.2;"
      );
      alignButton.addEventListener("click", () => {
        alignButton.textContent = "Aligning…";
        forceMeasure();
      });
      dock.appendChild(alignButton);
    }

    const toggleButton = document.createElement("button");
    toggleButton.id = TOGGLE_BUTTON_ID;
    toggleButton.type = "button";
    toggleButton.title = "Toggle dark mode on this page";
    toggleButton.setAttribute(
      "style",
      BUTTON_STYLE + "padding:8px 12px;font-size:12px;font-weight:600;line-height:1.2;"
    );
    syncToggleLabel(toggleButton);

    toggleButton.addEventListener("click", () => {
      setPageEnabled(!isPageEnabled());
      syncToggleLabel(toggleButton);
      chrome.runtime.sendMessage({ type: "analytics-event", event: "pageToggle" });
      readSettings(render);
    });
    dock.appendChild(toggleButton);

    document.body.appendChild(dock);
  }

  function flashAlignButton(matched) {
    const button = document.getElementById(ALIGN_BUTTON_ID);
    if (!button) return;
    button.textContent = matched ? "Aligned" : "No page found";
    setTimeout(() => {
      const still = document.getElementById(ALIGN_BUTTON_ID);
      if (still) still.textContent = "Re-align";
    }, 1400);
  }

  function syncToggleLabel(button) {
    if (!button) return;
    const enabled = isPageEnabled();
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "Dark mode: On" : "Dark mode: Off";
  }

  function openPopupFromPage() {
    const fallback = () => {
      if (globalThis.chrome?.runtime?.getURL) {
        window.open(chrome.runtime.getURL("popup/popup.html"), "_blank", "noopener,noreferrer");
      }
    };

    if (!globalThis.chrome?.runtime?.sendMessage) {
      fallback();
      return;
    }

    chrome.runtime.sendMessage({ type: "open-popup" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) fallback();
    });
  }
})();
