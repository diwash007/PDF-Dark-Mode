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

let activeState = true;
let currentTab = null;
let currentHost = "";

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

toggle.addEventListener("click", () => {
  activeState = !activeState;
  toggle.style.color = activeState ? "lime" : "red";
  persistSyncValue("active", activeState);
  applyPreviewFromControls();
  sendAnalyticsEvent("iconToggles");
});

modeSelect.addEventListener("change", () => {
  persistSyncValue("mode", modeSelect.value);
  applyPreviewFromControls();
});

allowCurrentSiteBtn.addEventListener("click", async () => {
  if (!currentHost) return;
  await setSiteRule(currentHost, "allow");
  await refreshSiteRuleLabels();
  applyPreviewFromControls();
});

blockCurrentSiteBtn.addEventListener("click", async () => {
  if (!currentHost) return;
  await setSiteRule(currentHost, "block");
  await refreshSiteRuleLabels();
  applyPreviewFromControls();
});

clearCurrentSiteBtn.addEventListener("click", async () => {
  if (!currentHost) return;
  await clearSiteRule(currentHost);
  await refreshSiteRuleLabels();
  applyPreviewFromControls();
});

allowManualSiteBtn.addEventListener("click", async () => {
  const host = normalizeHostname(manualSiteInput.value);
  if (!host) return;
  await setSiteRule(host, "allow");
  manualSiteInput.value = "";
  await refreshSiteRuleLabels();
});

blockManualSiteBtn.addEventListener("click", async () => {
  const host = normalizeHostname(manualSiteInput.value);
  if (!host) return;
  await setSiteRule(host, "block");
  manualSiteInput.value = "";
  await refreshSiteRuleLabels();
});

window.addEventListener("DOMContentLoaded", function () {
  const link = document.getElementById("portfolio");
  link.addEventListener("click", function () {
    chrome.tabs.create({ url: "https://diwashdahal.com.np/" });
  });
});

async function initializePopup() {
  const syncState = await getSyncState(["strength", "contrast", "mode", "active"]);
  slider.value = syncState.strength || 255;
  contrastSlider.value = syncState.contrast || 100;
  modeSelect.value = syncState.mode || "dark";
  activeState = typeof syncState.active === "boolean" ? syncState.active : true;
  toggle.style.color = activeState ? "lime" : "red";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  currentHost = getHostnameFromUrl(currentTab?.url);

  await refreshSiteRuleLabels();
  renderAnalyticsSummary();
}

async function applyPreviewFromControls() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || currentTab;
  const tabUrl = currentTab?.url || "";

  const siteRules = (await getSyncState(["siteRules"])).siteRules || {};
  const policy = buildUrlPolicy(tabUrl, siteRules);

  if (!policy.shouldInject) {
    return;
  }

  const settings = {
    active: activeState,
    strength: Number(slider.value),
    contrast: Number(contrastSlider.value),
    mode: modeSelect.value || "dark",
  };

  await chrome.scripting
    .executeScript({
      target: { tabId: currentTab.id },
      func: (previewSettings, applyPolicy) => {
        const DARK_LAYER_ID = "darkDiv";
        const TINT_LAYER_ID = "tintDiv";

        const removeLayer = (id) => {
          const layer = document.getElementById(id);
          if (layer) layer.remove();
        };

        const hasEmbeddedPdfPreview = () =>
          !!document.querySelector(
            'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], iframe[src*="/file/d/"][src*="/preview"], iframe[src*="docs.google.com/gview"], iframe[src*="/viewerng/viewer"], iframe[src*="/viewer"]'
          );

        removeLayer(DARK_LAYER_ID);
        removeLayer(TINT_LAYER_ID);

        if (!previewSettings.active) return;
        if (applyPolicy.requiresEmbeddedPreview && !hasEmbeddedPdfPreview()) return;

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
        const strength = clamp(Number(previewSettings.strength) || 255, 200, 255);
        const contrast = clamp(Number(previewSettings.contrast) || 100, 50, 130);
        const mode = previewSettings.mode || "dark";
        const blendStrengthHex =
          mode === "amoled" ? "ff" : strength.toString(16).padStart(2, "0");
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
      },
      args: [settings, policy],
    })
    .catch((error) => {
      console.error("PDF Dark Mode: failed to apply mode", error);
    });
}

async function refreshSiteRuleLabels() {
  currentHost = getHostnameFromUrl(currentTab?.url);
  currentHostLabel.textContent = `Current site: ${currentHost || "n/a"}`;

  if (!currentHost) {
    currentRuleLabel.textContent = "Rule: default";
    return;
  }

  const siteRules = (await getSyncState(["siteRules"])).siteRules || {};
  const rule = siteRules[currentHost] || "default";
  currentRuleLabel.textContent = `Rule: ${rule}`;
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
  chrome.storage.sync.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      console.error("PDF Dark Mode: failed to save setting", chrome.runtime.lastError);
    }
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

function buildUrlPolicy(url, siteRules) {
  const host = getHostnameFromUrl(url);
  const siteRule = host ? siteRules[host] : "";

  if (siteRule === "block") {
    return { shouldInject: false, requiresEmbeddedPreview: false };
  }

  const isStandardPdf =
    /\.pdf($|[?#&])/i.test(url || "") ||
    (/^chrome-extension:\/\/[^/]+\/index\.html/i.test(url || "") &&
      (new URL(url).searchParams.get("src") || "").match(
        /\.pdf($|[?#&])|%2Epdf/i
      )) ||
    /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/(?:view|preview)/i.test(
      url || ""
    ) ||
    /^https:\/\/docs\.google\.com\/(?:viewer|gview)/i.test(url || "");

  if (isStandardPdf) {
    return { shouldInject: true, requiresEmbeddedPreview: false };
  }

  if (siteRule === "allow") {
    return { shouldInject: true, requiresEmbeddedPreview: false };
  }

  return { shouldInject: false, requiresEmbeddedPreview: false };
}
