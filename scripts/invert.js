(() => {
  const DARK_LAYER_ID = "darkDiv";
  const TINT_LAYER_ID = "tintDiv";
  const href = window.location.href;

  chrome.storage.sync.get(
    ["active", "strength", "contrast", "mode", "siteRules", "billing"],
    (state) => {
      const entitlement = getEntitlement(state.billing);
      const policy = buildPagePolicy(href, state.siteRules || {}, entitlement);
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

    if (!state.active || !policy.shouldApply) {
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

    const darkLayer = document.createElement("div");
    darkLayer.id = DARK_LAYER_ID;
    darkLayer.setAttribute(
      "style",
      `
        position: fixed;
        pointer-events: none;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
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
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background-color: rgba(112, 66, 20, 0.2);
          mix-blend-mode: multiply;
          z-index: 2147483647;
        `
      );
      document.body.appendChild(tintLayer);
    }
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

    return { isPro: !!billing.proOverride || hasPaidPlan };
  }

  function defaultBilling() {
    return {
      plan: "free",
      status: "inactive",
      source: "local-flag",
      proOverride: false,
    };
  }
})();
