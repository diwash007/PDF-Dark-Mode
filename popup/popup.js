const PRICING_URL = "https://pdf.gilobyte.com/#pricing";
const SUPPORT_URL = "https://pdf.gilobyte.com/#contact";
const ENABLE_DEBUG_BILLING_TOOLS = false;

const slider = document.getElementById("slider");
const toggle = document.getElementById("toggle");
const contrastSlider = document.getElementById("contrastSlider");
const modeSelect = document.getElementById("modeSelect");
const analyticsSummary = document.getElementById("analyticsSummary");
const currentHostLabel = document.getElementById("currentHostLabel");
const currentRuleLabel = document.getElementById("currentRuleLabel");
const allowCurrentSiteBtn = document.getElementById("allowCurrentSiteBtn");
const blockCurrentSiteBtn = document.getElementById("blockCurrentSiteBtn");
const clearCurrentSiteBtn = document.getElementById("clearCurrentSiteBtn");
const manualSiteInput = document.getElementById("manualSiteInput");
const allowManualSiteBtn = document.getElementById("allowManualSiteBtn");
const blockManualSiteBtn = document.getElementById("blockManualSiteBtn");
const planLabel = document.getElementById("planLabel");
const subscribeBtn = document.getElementById("subscribeBtn");
const haveLicenseToggleBtn = document.getElementById("haveLicenseToggleBtn");
const licenseActivationPanel = document.getElementById("licenseActivationPanel");
const activateLicenseBtn = document.getElementById("activateLicenseBtn");
const licenseKeyInput = document.getElementById("licenseKeyInput");
const licenseStatus = document.getElementById("licenseStatus");
const debugBillingSection = document.getElementById("debugBillingSection");
const debugRevokeBtn = document.getElementById("debugRevokeBtn");
const siteRuleBox = document.querySelector(".site-rule-box");

// Overlay area elements
const topMarginSlider = document.getElementById("topMarginSlider");
const rightMarginSlider = document.getElementById("rightMarginSlider");
const bottomMarginSlider = document.getElementById("bottomMarginSlider");
const leftMarginSlider = document.getElementById("leftMarginSlider");
const topMarginValue = document.getElementById("topMarginValue");
const rightMarginValue = document.getElementById("rightMarginValue");
const bottomMarginValue = document.getElementById("bottomMarginValue");
const leftMarginValue = document.getElementById("leftMarginValue");
const resetAreaBtn = document.getElementById("resetAreaBtn");
const saveAreaBtn = document.getElementById("saveAreaBtn");
const areaStatus = document.getElementById("areaStatus");
const previewArea = document.getElementById("previewArea");
const overlayAreaBox = document.querySelector(".overlay-area-box");

let activeState = true;
let currentTab = null;
let currentHost = "";
let entitlement = { isPro: false, planName: "Free", billing: defaultBilling() };
let licensePanelOpen = false;
let overlayAreaCustomizations = { top: 0, right: 0, bottom: 0, left: 0 };
let siteSpecificAreaActive = false;

initializePopup();

slider.addEventListener("input", () => {
  applyPreviewFromControls();
});

slider.addEventListener("change", () => {
  persistSyncValue("strength", Number(slider.value));
});

contrastSlider.addEventListener("input", () => {
  applyPreviewFromControls();
});

contrastSlider.addEventListener("change", () => {
  persistSyncValue("contrast", Number(contrastSlider.value));
});

topMarginSlider.addEventListener("input", () => {
  overlayAreaCustomizations.top = Number(topMarginSlider.value);
  topMarginValue.textContent = `${topMarginSlider.value}px`;
  updatePreviewArea();
  applyPreviewFromControls();
});

topMarginSlider.addEventListener("change", () => {
  if (entitlement.isPro && siteSpecificAreaActive) {
    saveAreaForCurrentSite();
  }
});

rightMarginSlider.addEventListener("input", () => {
  overlayAreaCustomizations.right = Number(rightMarginSlider.value);
  rightMarginValue.textContent = `${rightMarginSlider.value}px`;
  updatePreviewArea();
  applyPreviewFromControls();
});

rightMarginSlider.addEventListener("change", () => {
  if (entitlement.isPro && siteSpecificAreaActive) {
    saveAreaForCurrentSite();
  }
});

bottomMarginSlider.addEventListener("input", () => {
  overlayAreaCustomizations.bottom = Number(bottomMarginSlider.value);
  bottomMarginValue.textContent = `${bottomMarginSlider.value}px`;
  updatePreviewArea();
  applyPreviewFromControls();
});

bottomMarginSlider.addEventListener("change", () => {
  if (entitlement.isPro && siteSpecificAreaActive) {
    saveAreaForCurrentSite();
  }
});

leftMarginSlider.addEventListener("input", () => {
  overlayAreaCustomizations.left = Number(leftMarginSlider.value);
  leftMarginValue.textContent = `${leftMarginSlider.value}px`;
  updatePreviewArea();
  applyPreviewFromControls();
});

leftMarginSlider.addEventListener("change", () => {
  if (entitlement.isPro && siteSpecificAreaActive) {
    saveAreaForCurrentSite();
  }
});

resetAreaBtn.addEventListener("click", async () => {
  overlayAreaCustomizations = { top: 0, right: 0, bottom: 0, left: 0 };
  topMarginSlider.value = 0;
  rightMarginSlider.value = 0;
  bottomMarginSlider.value = 0;
  leftMarginSlider.value = 0;
  topMarginValue.textContent = "0px";
  rightMarginValue.textContent = "0px";
  bottomMarginValue.textContent = "0px";
  leftMarginValue.textContent = "0px";
  
  if (entitlement.isPro && siteSpecificAreaActive) {
    await clearAreaForCurrentSite();
  }
  
  updatePreviewArea();
  applyPreviewFromControls();
});

saveAreaBtn.addEventListener("click", async () => {
  if (!entitlement.isPro || !currentHost) return;
  siteSpecificAreaActive = true;
  await saveAreaForCurrentSite();
  await loadAreaSettings();
  updateAreaUI();
  applyPreviewFromControls();
});

toggle.addEventListener("click", () => {
  activeState = !activeState;
  toggle.style.color = activeState ? "lime" : "red";
  persistSyncValue("active", activeState);
  applyPreviewFromControls();
  sendAnalyticsEvent("iconToggles");
});

modeSelect.addEventListener("change", () => {
  const nextMode = enforceAllowedMode(modeSelect.value);
  modeSelect.value = nextMode;
  persistSyncValue("mode", nextMode);
  applyPreviewFromControls();
});

allowCurrentSiteBtn.addEventListener("click", async () => {
  if (!entitlement.isPro || !currentHost) return;
  await setSiteRule(currentHost, "allow");
  await refreshSiteRuleLabels();
  applyPreviewFromControls();
});

blockCurrentSiteBtn.addEventListener("click", async () => {
  if (!entitlement.isPro || !currentHost) return;
  await setSiteRule(currentHost, "block");
  await refreshSiteRuleLabels();
  applyPreviewFromControls();
});

clearCurrentSiteBtn.addEventListener("click", async () => {
  if (!entitlement.isPro || !currentHost) return;
  await clearSiteRule(currentHost);
  await refreshSiteRuleLabels();
  applyPreviewFromControls();
});

allowManualSiteBtn.addEventListener("click", async () => {
  if (!entitlement.isPro) return;
  const host = normalizeHostname(manualSiteInput.value);
  if (!host) return;
  await setSiteRule(host, "allow");
  manualSiteInput.value = "";
  await refreshSiteRuleLabels();
});

blockManualSiteBtn.addEventListener("click", async () => {
  if (!entitlement.isPro) return;
  const host = normalizeHostname(manualSiteInput.value);
  if (!host) return;
  await setSiteRule(host, "block");
  manualSiteInput.value = "";
  await refreshSiteRuleLabels();
});

subscribeBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: PRICING_URL });
});

haveLicenseToggleBtn.addEventListener("click", () => {
  licensePanelOpen = !licensePanelOpen;
  renderLicenseActivationPanel();
});

activateLicenseBtn.addEventListener("click", async () => {
  const licenseKey = normalizeLicenseKey(licenseKeyInput.value);
  if (!licenseKey) {
    renderLicenseStatus("Please enter a valid license key.", "error");
    return;
  }

  setBillingBusyState(true);
  renderLicenseStatus("Activating license...", "");
  const response = await sendRuntimeMessage({
    type: "license-activate",
    licenseKey,
  });
  setBillingBusyState(false);

  if (!response?.ok) {
    renderLicenseStatus(response?.error || "Activation failed.", "error");
    return;
  }

  entitlement = getEntitlement(response.billing);
  renderEntitlementUI();
  await refreshSiteRuleLabels();
  modeSelect.value = enforceAllowedMode(modeSelect.value);
  await persistSyncValue("mode", modeSelect.value);
  applyPreviewFromControls();
  renderLicenseStatus("License activated. Pro features are now enabled.", "success");
  licensePanelOpen = false;
  renderLicenseActivationPanel();
});

debugRevokeBtn.addEventListener("click", async () => {
  if (!ENABLE_DEBUG_BILLING_TOOLS) {
    return;
  }

  const revokedBilling = {
    ...entitlement.billing,
    plan: "free",
    status: "inactive",
    licenseStatus: "invalid",
    errorMessage: "Debug revoke applied locally.",
  };

  await persistSyncValue("billing", revokedBilling);
  entitlement = getEntitlement(revokedBilling);
  renderEntitlementUI();
  await refreshSiteRuleLabels();
  modeSelect.value = enforceAllowedMode(modeSelect.value);
  await persistSyncValue("mode", modeSelect.value);
  applyPreviewFromControls();
  renderLicenseActivationPanel();
  renderLicenseStatus("Debug revoke applied. Pro is now disabled locally.", "error");
});

window.addEventListener("DOMContentLoaded", () => {
  const link = document.getElementById("supportLink");
  link.addEventListener("click", () => {
    chrome.tabs.create({
      url: SUPPORT_URL,
    });
  });
});

async function initializePopup() {
  const syncState = await getSyncState([
    "strength",
    "contrast",
    "mode",
    "active",
    "billing",
    "overlayAreaSettings",
    "siteOverlayAreas",
  ]);

  entitlement = getEntitlement(syncState.billing);

  slider.value = syncState.strength || 255;
  contrastSlider.value = syncState.contrast || 100;
  modeSelect.value = enforceAllowedMode(syncState.mode || "dark");
  activeState = typeof syncState.active === "boolean" ? syncState.active : true;
  toggle.style.color = activeState ? "lime" : "red";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  currentHost = getHostnameFromUrl(currentTab?.url);

  detectAndUpdateSliderMax(tab);
  await loadAreaSettings();

  renderEntitlementUI();
  updateAreaUI();
  await refreshSiteRuleLabels();
  renderAnalyticsSummary();
  renderLicenseActivationPanel();
  renderDebugBillingTools();

  if (syncState.mode !== modeSelect.value) {
    await persistSyncValue("mode", modeSelect.value);
  }

  if (syncState.billing?.status === "active") {
    renderLicenseStatus("License found. Background validation runs automatically.", "success");
  }
}

async function detectAndUpdateSliderMax(tab) {
  if (!tab?.id) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        return {
          width: window.innerWidth,
          height: window.innerHeight,
        };
      },
    });

    if (results && results[0] && results[0].result) {
      const { width, height } = results[0].result;
      const maxMarginHeight = height;
      const maxMarginWidth = width;

      topMarginSlider.max = maxMarginHeight;
      rightMarginSlider.max = maxMarginWidth;
      bottomMarginSlider.max = maxMarginHeight;
      leftMarginSlider.max = maxMarginWidth;
    }
  } catch (error) {
    // If detection fails, keep the default max of 1000
    console.log("Could not detect viewport dimensions, using default max");
  }
}

async function applyPreviewFromControls() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || currentTab;
  const tabUrl = currentTab?.url || "";

  const siteRules = (await getSyncState(["siteRules"])).siteRules || {};
  const policy = buildUrlPolicy(tabUrl, siteRules, entitlement);

  if (!policy.shouldInject || !currentTab?.id) {
    return;
  }

  const settings = {
    active: activeState,
    strength: Number(slider.value),
    contrast: Number(contrastSlider.value),
    mode: enforceAllowedMode(modeSelect.value),
    overlayArea: overlayAreaCustomizations,
  };

  await chrome.scripting
    .executeScript({
      target: { tabId: currentTab.id },
      func: (previewSettings) => {
        const DARK_LAYER_ID = "darkDiv";
        const TINT_LAYER_ID = "tintDiv";

        const removeLayer = (id) => {
          const layer = document.getElementById(id);
          if (layer) layer.remove();
        };

        removeLayer(DARK_LAYER_ID);
        removeLayer(TINT_LAYER_ID);

        if (!previewSettings.active) return;

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
        const strength = clamp(Number(previewSettings.strength) || 255, 200, 255);
        const contrast = clamp(Number(previewSettings.contrast) || 100, 50, 130);
        const mode = previewSettings.mode || "dark";
        const blendStrengthHex =
          mode === "amoled" ? "ff" : strength.toString(16).padStart(2, "0");
        const contrastValue = mode === "amoled" ? Math.max(contrast, 110) : contrast;
        const brightnessValue = mode === "amoled" ? 78 : 100;

        const area = previewSettings.overlayArea || { top: 0, right: 0, bottom: 0, left: 0 };

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
      },
      args: [settings],
    })
    .catch((error) => {
      console.error("PDF Dark Mode: failed to apply mode", error);
    });
}

function renderEntitlementUI() {
  planLabel.textContent = `Plan: ${entitlement.planName}`;
  planLabel.classList.remove("pro", "lifetime", "free");
  if (entitlement.isPro) {
    planLabel.classList.add(entitlement.billing.plan === "lifetime" ? "lifetime" : "pro");
  } else {
    planLabel.classList.add("free");
  }
  licenseKeyInput.value = entitlement.billing.licenseKey || "";

  modeSelect.options[1].disabled = !entitlement.isPro;
  modeSelect.options[2].disabled = !entitlement.isPro;

  const controls = [
    allowCurrentSiteBtn,
    blockCurrentSiteBtn,
    clearCurrentSiteBtn,
    manualSiteInput,
    allowManualSiteBtn,
    blockManualSiteBtn,
  ];
  controls.forEach((element) => {
    element.disabled = !entitlement.isPro;
  });

  subscribeBtn.style.display = entitlement.isPro ? "none" : "block";

  siteRuleBox.classList.toggle("locked", !entitlement.isPro);
}

async function refreshSiteRuleLabels() {
  currentHost = getHostnameFromUrl(currentTab?.url);
  currentHostLabel.textContent = `Current site: ${currentHost || "n/a"}`;

  if (!entitlement.isPro) {
    currentRuleLabel.textContent = "Rule: Pro feature";
    return;
  }

  if (!currentHost) {
    currentRuleLabel.textContent = "Rule: default";
    return;
  }

  const siteRules = (await getSyncState(["siteRules"])).siteRules || {};
  const rule = siteRules[currentHost] || "default";
  currentRuleLabel.textContent = `Rule: ${rule}`;
}

function renderLicenseStatus(message, type) {
  licenseStatus.textContent = message;
  licenseStatus.classList.remove("error", "success");
  if (type === "error" || type === "success") {
    licenseStatus.classList.add(type);
  }
}

function renderLicenseActivationPanel() {
  if (entitlement.isPro) {
    licenseActivationPanel.classList.add("hidden");
    haveLicenseToggleBtn.textContent = "License is active";
    haveLicenseToggleBtn.disabled = true;
    return;
  }

  haveLicenseToggleBtn.disabled = false;
  haveLicenseToggleBtn.textContent = licensePanelOpen
    ? "Hide activation form"
    : "Have a license? Activate here";
  licenseActivationPanel.classList.toggle("hidden", !licensePanelOpen);
}

function renderDebugBillingTools() {
  debugBillingSection.classList.toggle("hidden", !ENABLE_DEBUG_BILLING_TOOLS);
}

function setBillingBusyState(isBusy) {
  activateLicenseBtn.disabled = isBusy;
  subscribeBtn.disabled = isBusy;
  haveLicenseToggleBtn.disabled = isBusy || entitlement.isPro;
  debugRevokeBtn.disabled = isBusy || !ENABLE_DEBUG_BILLING_TOOLS;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    const send = (retry) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError) {
          if (retry && /message port closed before a response/i.test(runtimeError)) {
            setTimeout(() => send(false), 120);
            return;
          }
          resolve({ ok: false, error: runtimeError });
          return;
        }
        resolve(response || { ok: false, error: "No response from service worker." });
      });
    };

    send(true);
  });
}

function setSiteRule(host, rule) {
  return new Promise((resolve) => {
    chrome.storage.sync.get("siteRules", ({ siteRules }) => {
      const nextRules = { ...(siteRules || {}), [host]: rule };
      chrome.storage.sync.set({ siteRules: nextRules }, () => {
        if (chrome.runtime.lastError) {
          console.error("PDF Dark Mode: failed to save site rule", chrome.runtime.lastError);
        }
        resolve();
      });
    });
  });
}

function clearSiteRule(host) {
  return new Promise((resolve) => {
    chrome.storage.sync.get("siteRules", ({ siteRules }) => {
      const nextRules = { ...(siteRules || {}) };
      delete nextRules[host];
      chrome.storage.sync.set({ siteRules: nextRules }, () => {
        if (chrome.runtime.lastError) {
          console.error("PDF Dark Mode: failed to clear site rule", chrome.runtime.lastError);
        }
        resolve();
      });
    });
  });
}

function persistSyncValue(key, value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.error("PDF Dark Mode: failed to save setting", chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

function sendAnalyticsEvent(eventName) {
  chrome.runtime.sendMessage({ type: "analytics-event", event: eventName });
}

function renderAnalyticsSummary() {
  chrome.storage.local.get("analytics", ({ analytics }) => {
    const totals = sumLast7Days(analytics?.pdfAppliesByDay || {});
    analyticsSummary.textContent = `Local analytics: ${totals} PDF sessions in last 7 days`;
  });
}

function sumLast7Days(pdfAppliesByDay) {
  const currentDay = new Date();
  let sum = 0;

  for (let i = 0; i < 7; i += 1) {
    const day = new Date(currentDay);
    day.setDate(currentDay.getDate() - i);
    const dayKey = day.toISOString().slice(0, 10);
    sum += pdfAppliesByDay[dayKey] || 0;
  }

  return sum;
}

function getSyncState(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, resolve);
  });
}

function getHostnameFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeHostname(value) {
  const text = (value || "").trim().toLowerCase();
  if (!text) return "";

  try {
    const withProtocol = text.includes("://") ? text : `https://${text}`;
    return new URL(withProtocol).hostname;
  } catch {
    return "";
  }
}

function normalizeLicenseKey(value) {
  return (value || "").trim().toUpperCase();
}

function buildUrlPolicy(url, siteRules, currentEntitlement) {
  const host = getHostnameFromUrl(url);
  const canUseSiteRules = currentEntitlement.isPro;
  const siteRule = canUseSiteRules && host ? siteRules[host] : "";

  if (siteRule === "block") {
    return { shouldInject: false };
  }

  const isStandardPdf =
    /\.pdf($|[?#&])/i.test(url || "") ||
    (/^chrome-extension:\/\/[^/]+\/index\.html/i.test(url || "") &&
      (new URL(url).searchParams.get("src") || "").match(
        /\.pdf($|[?#&])|%2Epdf/i
      ));

  if (isStandardPdf) {
    return { shouldInject: true };
  }

  if (siteRule === "allow") {
    return { shouldInject: true };
  }

  return { shouldInject: false };
}

function enforceAllowedMode(mode) {
  if (!entitlement.isPro && mode !== "dark") {
    return "dark";
  }
  return mode || "dark";
}

function getEntitlement(billingState) {
  const billing = {
    ...defaultBilling(),
    ...(billingState || {}),
  };

  const hasPaidPlan =
    billing.status === "active" &&
    (billing.plan === "pro" || billing.plan === "lifetime");
  const isPro = hasPaidPlan;
  const planName = isPro ? (billing.plan === "lifetime" ? "Lifetime" : "Pro") : "Free";

  return {
    isPro,
    planName,
    billing,
  };
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

async function loadAreaSettings() {
  const syncState = await getSyncState(["overlayAreaSettings", "siteOverlayAreas"]);
  const globalSettings = syncState.overlayAreaSettings || { top: 0, right: 0, bottom: 0, left: 0 };
  const siteAreas = syncState.siteOverlayAreas || {};

  if (entitlement.isPro && currentHost && siteAreas[currentHost]) {
    overlayAreaCustomizations = siteAreas[currentHost];
    siteSpecificAreaActive = true;
  } else {
    overlayAreaCustomizations = globalSettings;
    siteSpecificAreaActive = false;
  }

  topMarginSlider.value = overlayAreaCustomizations.top || 0;
  rightMarginSlider.value = overlayAreaCustomizations.right || 0;
  bottomMarginSlider.value = overlayAreaCustomizations.bottom || 0;
  leftMarginSlider.value = overlayAreaCustomizations.left || 0;

  updateMarginValues();
}

function updateMarginValues() {
  topMarginValue.textContent = `${topMarginSlider.value}px`;
  rightMarginValue.textContent = `${rightMarginSlider.value}px`;
  bottomMarginValue.textContent = `${bottomMarginSlider.value}px`;
  leftMarginValue.textContent = `${leftMarginSlider.value}px`;
}

function updatePreviewArea() {
  const previewBox = document.querySelector(".preview-box");
  const boxRect = previewBox.getBoundingClientRect();
  const boxWidth = boxRect.width;
  const boxHeight = boxRect.height;
  
  const maxMargin = Number(topMarginSlider.max) || 1000;
  const topPercent = (overlayAreaCustomizations.top / maxMargin) * 100;
  const rightPercent = (overlayAreaCustomizations.right / maxMargin) * 100;
  const bottomPercent = (overlayAreaCustomizations.bottom / maxMargin) * 100;
  const leftPercent = (overlayAreaCustomizations.left / maxMargin) * 100;

  previewArea.style.top = `${topPercent}%`;
  previewArea.style.right = `${rightPercent}%`;
  previewArea.style.bottom = `${bottomPercent}%`;
  previewArea.style.left = `${leftPercent}%`;
}

function updateAreaUI() {
  updateMarginValues();
  updatePreviewArea();

  saveAreaBtn.disabled = !entitlement.isPro;

  if (!entitlement.isPro) {
    areaStatus.textContent = "Using temporary customization (not saved)";
  } else if (siteSpecificAreaActive && currentHost) {
    areaStatus.textContent = `Site-specific area active for ${currentHost}`;
  } else {
    areaStatus.textContent = "Using global area settings";
  }
}

async function saveAreaForCurrentSite() {
  if (!entitlement.isPro || !currentHost) return;

  return new Promise((resolve) => {
    chrome.storage.sync.get("siteOverlayAreas", ({ siteOverlayAreas }) => {
      const nextAreas = {
        ...(siteOverlayAreas || {}),
        [currentHost]: overlayAreaCustomizations,
      };
      chrome.storage.sync.set({ siteOverlayAreas: nextAreas }, () => {
        if (chrome.runtime.lastError) {
          console.error("PDF Dark Mode: failed to save area for site", chrome.runtime.lastError);
        }
        resolve();
      });
    });
  });
}

async function clearAreaForCurrentSite() {
  if (!entitlement.isPro || !currentHost) return;

  return new Promise((resolve) => {
    chrome.storage.sync.get("siteOverlayAreas", ({ siteOverlayAreas }) => {
      const nextAreas = { ...(siteOverlayAreas || {}) };
      delete nextAreas[currentHost];
      chrome.storage.sync.set({ siteOverlayAreas: nextAreas }, () => {
        if (chrome.runtime.lastError) {
          console.error("PDF Dark Mode: failed to clear area for site", chrome.runtime.lastError);
        }
        siteSpecificAreaActive = false;
        resolve();
      });
    });
  });
}
