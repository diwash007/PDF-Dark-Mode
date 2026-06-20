(() => {
  const DARK_LAYER_ID = "darkDiv";
  const TINT_LAYER_ID = "tintDiv";
  const ACTION_DOCK_ID = "pdfDarkModeDock";
  const TOGGLE_BUTTON_ID = "pdfDarkModeToggle";
  const INFO_BUTTON_ID = "pdfDarkModeInfo";
  const href = window.location.href;
  const pageEnabled =
    typeof window.__pdfDarkModePageEnabled === "boolean"
      ? window.__pdfDarkModePageEnabled
      : true;

  chrome.storage.sync.get(
    ["active", "strength", "contrast", "mode", "siteRules", "billing", "overlayAreaSettings", "siteOverlayAreas"],
    (state) => {
      const entitlement = getEntitlement(state.billing);
      const policy = buildPagePolicy(href, state.siteRules || {}, entitlement);
      installFloatingActions(policy.shouldApply);
      applyTheme(state, policy, entitlement);

      if (policy.requiresEmbeddedPreview) {
        installPreviewObserver(state, policy, entitlement);
      }
    }
  );

  function buildPagePolicy(url, siteRules, entitlement) {
    const hostname = getHostnameFromUrl(url);
    const siteRule = entitlement.isPro && hostname ? siteRules[hostname] : "";

    if (siteRule === "block") {
      return { shouldApply: false, requiresEmbeddedPreview: false };
    }

    const isStandardPdf =
      /\.pdf($|[?#&])/i.test(url) ||
      (/^chrome-extension:\/\/[^/]+\/index\.html/i.test(url) &&
        (new URL(url).searchParams.get("src") || "").match(
          /\.pdf($|[?#&])|%2Epdf/i
        )) ||
      /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/(?:view|preview)/i.test(
        url
      ) ||
      /^https:\/\/docs\.google\.com\/(?:viewer|gview)/i.test(url);

    if (isStandardPdf) {
      return { shouldApply: true, requiresEmbeddedPreview: false };
    }

    if (siteRule === "allow") {
      return { shouldApply: true, requiresEmbeddedPreview: false };
    }

    return { shouldApply: false, requiresEmbeddedPreview: false };
  }

  function installPreviewObserver(state, policy, entitlement) {
    if (window.__pdfDarkModePreviewObserverInstalled) {
      return;
    }
    window.__pdfDarkModePreviewObserverInstalled = true;

    let queued = false;
    const observer = new MutationObserver((mutations) => {
      if (queued || areOnlyExtensionLayerMutations(mutations)) {
        return;
      }

      queued = true;
      setTimeout(() => {
        queued = false;
        applyTheme(state, policy, entitlement);
      }, 120);
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function areOnlyExtensionLayerMutations(mutations) {
    const isExtensionLayerNode = (node) =>
      node?.nodeType === Node.ELEMENT_NODE &&
      (node.id === DARK_LAYER_ID || node.id === TINT_LAYER_ID);

    return mutations.every((mutation) => {
      const added = Array.from(mutation.addedNodes || []);
      const removed = Array.from(mutation.removedNodes || []);
      const touched = [...added, ...removed];

      if (touched.length > 0 && touched.some((node) => !isExtensionLayerNode(node))) {
        return false;
      }

      return !mutation.target || isExtensionLayerNode(mutation.target);
    });
  }

  function applyTheme(state, policy, entitlement) {
    removeLayer(DARK_LAYER_ID);
    removeLayer(TINT_LAYER_ID);

    if (!policy.shouldApply || !getPageToggleState()) {
      return;
    }

    if (policy.requiresEmbeddedPreview && !hasEmbeddedPdfPreview()) {
      return;
    }

    const strength = clamp(Number(state.strength) || 255, 200, 255);
    const contrast = clamp(Number(state.contrast) || 100, 50, 130);
    const mode = !entitlement.isPro && state.mode !== "dark" ? "dark" : state.mode || "dark";
    const blendStrengthHex = mode === "amoled" ? "ff" : strength.toString(16).padStart(2, "0");
    const contrastValue = mode === "amoled" ? Math.max(contrast, 110) : contrast;
    const brightnessValue = mode === "amoled" ? 78 : 100;

    const hostname = getHostnameFromUrl(href);
    const siteAreas = state.siteOverlayAreas || {};
    const globalArea = state.overlayAreaSettings || { top: 0, right: 0, bottom: 0, left: 0 };
    
    // Apply custom area settings for pro users (site-specific) or all users (global defaults)
    const area = entitlement.isPro && hostname && siteAreas[hostname] 
      ? siteAreas[hostname] 
      : globalArea;

    const darkLayer = document.createElement("div");
    darkLayer.id = DARK_LAYER_ID;
    darkLayer.setAttribute(
      "style",
      `
        position: fixed;
        pointer-events: none;
        top: ${area.top}px;
        left: ${area.left}px;
        right: ${area.right}px;
        bottom: ${area.bottom}px;
        width: calc(100vw - ${area.left}px - ${area.right}px);
        height: calc(100vh - ${area.top}px - ${area.bottom}px);
        background-color: #${blendStrengthHex}ffffff;
        mix-blend-mode: difference;
        z-index: 2147483646;
        filter: contrast(${contrastValue}%) brightness(${brightnessValue}%);
      `
    );
    document.body.appendChild(darkLayer);

    if (mode === "sepia") {
      const tintLayer = document.createElement("div");
      tintLayer.id = TINT_LAYER_ID;
      tintLayer.setAttribute(
        "style",
        `
          position: fixed;
          pointer-events: none;
          top: ${area.top}px;
          left: ${area.left}px;
          right: ${area.right}px;
          bottom: ${area.bottom}px;
          width: calc(100vw - ${area.left}px - ${area.right}px);
          height: calc(100vh - ${area.top}px - ${area.bottom}px);
          background-color: rgba(112, 66, 20, 0.2);
          mix-blend-mode: multiply;
          z-index: 2147483647;
        `
      );
      document.body.appendChild(tintLayer);
    }
  }

  function installFloatingActions(shouldShow) {
    if (!shouldShow || document.getElementById(ACTION_DOCK_ID)) {
      return;
    }

    const dock = document.createElement("div");
    dock.id = ACTION_DOCK_ID;
    dock.setAttribute(
      "style",
      `
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
      `
    );

    const infoButton = document.createElement("button");
    infoButton.id = INFO_BUTTON_ID;
    infoButton.type = "button";
    infoButton.title = "Open PDF Dark Mode";
    infoButton.setAttribute("aria-label", "Open PDF Dark Mode popup");
    infoButton.textContent = "i";
    infoButton.setAttribute(
      "style",
      `
        width: 28px;
        height: 28px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        padding: 0;
        background: rgba(17, 24, 39, 0.92);
        color: #f9fafb;
        font: 700 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
      `
    );

    infoButton.addEventListener("click", () => {
      openPopupFromPage();
    });

    const toggleButton = document.createElement("button");
    toggleButton.id = TOGGLE_BUTTON_ID;
    toggleButton.type = "button";
    toggleButton.setAttribute("aria-pressed", String(getPageToggleState()));
    toggleButton.title = "Toggle dark mode";
    toggleButton.textContent = getPageToggleState() ? "Dark mode: On" : "Dark mode: Off";
    toggleButton.setAttribute(
      "style",
      `
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(17, 24, 39, 0.92);
        color: #f9fafb;
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
      `
    );

    toggleButton.addEventListener("click", () => {
      const nextEnabled = !getPageToggleState();
      setPageToggleState(nextEnabled);
      toggleButton.setAttribute("aria-pressed", String(nextEnabled));
      toggleButton.textContent = nextEnabled ? "Dark mode: On" : "Dark mode: Off";
      chrome.runtime.sendMessage({ type: "analytics-event", event: "pageToggle" });
      chrome.storage.sync.get(["active", "siteRules", "billing"], (state) => {
        const entitlement = getEntitlement(state.billing);
        const policy = buildPagePolicy(href, state.siteRules || {}, entitlement);
        applyTheme(state, policy, entitlement);
      });
    });

    dock.appendChild(infoButton);
    dock.appendChild(toggleButton);
    document.body.appendChild(dock);
  }

  function openPopupFromPage() {
    if (globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "open-popup" }, () => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError && globalThis.chrome?.runtime?.getURL) {
          window.open(chrome.runtime.getURL("popup/popup.html"), "_blank", "noopener,noreferrer");
        }
      });
      return;
    }

    if (globalThis.chrome?.runtime?.getURL) {
      window.open(chrome.runtime.getURL("popup/popup.html"), "_blank", "noopener,noreferrer");
    }
  }

  function getPageToggleState() {
    return window.__pdfDarkModePageEnabled !== false && pageEnabled;
  }

  function setPageToggleState(enabled) {
    window.__pdfDarkModePageEnabled = !!enabled;
  }

  function hasEmbeddedPdfPreview() {
    return !!document.querySelector(
      'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], iframe[src*="/file/d/"][src*="/preview"], iframe[src*="docs.google.com/gview"], iframe[src*="/viewerng/viewer"], iframe[src*="/viewer"]'
    );
  }

  function getHostnameFromUrl(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  function removeLayer(id) {
    const layer = document.getElementById(id);
    if (layer) {
      layer.remove();
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getEntitlement(billingState) {
    const billing = {
      ...defaultBilling(),
      ...(billingState || {}),
    };
    const hasPaidPlan =
      billing.status === "active" &&
      (billing.plan === "pro" || billing.plan === "lifetime");

    return { isPro: hasPaidPlan };
  }

  function defaultBilling() {
    return {
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
    };
  }
})();
