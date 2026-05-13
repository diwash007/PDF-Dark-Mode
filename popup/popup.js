const slider = document.getElementById("slider");
const toggle = document.getElementById("toggle");
const contrastSlider = document.getElementById("contrastSlider");
const modeSelect = document.getElementById("modeSelect");
const analyticsSummary = document.getElementById("analyticsSummary");

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
  if (active) toggle.style.color = "lime";
  else toggle.style.color = "red";
});

// update dark mode strength on slider change
slider.addEventListener("change", () => {
  chrome.storage.sync.set({ strength: slider.value });
  sendAnalyticsEvent("strengthChanges");
  applyDarkMode();
});

// update contrast on slider change
contrastSlider.addEventListener("change", () => {
  chrome.storage.sync.set({ contrast: contrastSlider.value });
  sendAnalyticsEvent("contrastChanges");
  applyDarkMode();
});

// toggle active state on icon click
toggle.addEventListener("click", () => {
  chrome.storage.sync.get("active", ({ active }) => {
    if (active) {
      chrome.storage.sync.set({ active: false });
      toggle.style.color = "red";
    } else {
      chrome.storage.sync.set({ active: true });
      toggle.style.color = "lime";
    }
    sendAnalyticsEvent("iconToggles");
    applyDarkMode();
  });
});

modeSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ mode: modeSelect.value });
  sendAnalyticsEvent("modeChanges");
  applyDarkMode();
});

window.addEventListener("DOMContentLoaded", function () {
  const link = document.getElementById("portfolio");
  link.addEventListener("click", function () {
    chrome.tabs.create({ url: "https://diwashdahal.com.np/" });
  });
  renderAnalyticsSummary();
});

// apply dark mode if viewing PDF
async function applyDarkMode() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.url && (tab.url.includes(".pdf") || tab.url.includes(".PDF"))) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scripts/invert.js"],
    });
  }
}

function sendAnalyticsEvent(eventName) {
  chrome.runtime.sendMessage({ type: "analytics-event", event: eventName });
  renderAnalyticsSummary();
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
