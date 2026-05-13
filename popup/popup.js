const slider = document.getElementById("slider");
const toggle = document.getElementById("toggle");
const contrastSlider = document.getElementById("contrastSlider");
const modeSelect = document.getElementById("modeSelect");
const analyticsSummary = document.getElementById("analyticsSummary");
let activeState = true;

// update state of slider on popup
chrome.storage.sync.get("strength", ({ strength }) => {
  slider.value = strength;
});

// update state of contrast on popup
chrome.storage.sync.get("contrast", ({ contrast }) => {
  contrastSlider.value = contrast;
});

// update mode state on popup
chrome.storage.sync.get("mode", ({ mode }) => {
  modeSelect.value = mode || "dark";
});

// update state of toggle on popup
chrome.storage.sync.get("active", ({ active }) => {
  activeState = typeof active === "boolean" ? active : true;
  toggle.style.color = activeState ? "lime" : "red";
});

// update dark mode strength with live preview
slider.addEventListener("input", () => {
  applyPreviewFromControls();
});

slider.addEventListener("change", () => {
  persistSyncValue("strength", Number(slider.value));
});

// update contrast with live preview
contrastSlider.addEventListener("input", () => {
  applyPreviewFromControls();
});

contrastSlider.addEventListener("change", () => {
  persistSyncValue("contrast", Number(contrastSlider.value));
});

// toggle active state on icon click
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

window.addEventListener("DOMContentLoaded", function () {
  const link = document.getElementById("portfolio");
  link.addEventListener("click", function () {
    chrome.tabs.create({ url: "https://diwashdahal.com.np/" });
  });
  renderAnalyticsSummary();
});

async function applyPreviewFromControls() {
  const settings = {
    active: activeState,
    strength: Number(slider.value),
    contrast: Number(contrastSlider.value),
    mode: modeSelect.value || "dark",
  };

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isPdfTabUrl(tab?.url)) {
    await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        func: (previewSettings) => {
          const DARK_LAYER_ID = "darkDiv";
          const TINT_LAYER_ID = "tintDiv";

          const removeLayer = (id) => {
            const layer = document.getElementById(id);
            if (layer) {
              layer.remove();
            }
          };

          removeLayer(DARK_LAYER_ID);
          removeLayer(TINT_LAYER_ID);

          if (!previewSettings.active) {
            return;
          }

          const clamp = (value, min, max) =>
            Math.max(min, Math.min(max, value));
          const strength = clamp(Number(previewSettings.strength) || 255, 200, 255);
          const contrast = clamp(Number(previewSettings.contrast) || 100, 50, 130);
          const mode = previewSettings.mode || "dark";
          const blendStrengthHex =
            mode === "amoled"
              ? "ff"
              : strength.toString(16).padStart(2, "0");
          const contrastValue =
            mode === "amoled" ? Math.max(contrast, 110) : contrast;
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
        args: [settings],
      })
      .catch((error) => {
        console.error("PDF Dark Mode: failed to apply mode", error);
      });
  }
}

function persistSyncValue(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      console.error("PDF Dark Mode: failed to save setting", chrome.runtime.lastError);
    }
  });
}

function isPdfTabUrl(url) {
  if (!url) {
    return false;
  }

  return (
    /\.pdf($|[?#&])/i.test(url) ||
    (/^chrome-extension:\/\/[^/]+\/index\.html/i.test(url) &&
      (new URL(url).searchParams.get("src") || "").match(
        /\.pdf($|[?#&])|%2Epdf/i
      ))
  );
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
