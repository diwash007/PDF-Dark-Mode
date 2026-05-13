/*
 * This script is always running in background and don't have access to the curent tab
 * so it's a listener. It triggers event with sendMessage and executeScript
 */

const ANALYTICS_RETENTION_DAYS = 35;

ensureSyncDefault("active", true);
ensureSyncDefault("strength", 255);
ensureSyncDefault("contrast", 100);
ensureSyncDefault("mode", "dark");
ensureLocalDefault("analytics", { events: {}, pdfAppliesByDay: {} });

// tab update listener
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url) {
    return;
  }

  const extension = tab.url.slice(-4);
  if (tab.url && (extension === ".pdf" || extension === ".PDF")) {
    if (tabId)
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["scripts/invert.js"],
      });
  }

  return;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({
    url: "./instruction/index.html",
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "run-dark-mode") {
    recordAnalyticsEvent("shortcutToggles");
    chrome.storage.sync.get("active", ({ active }) => {
      chrome.storage.sync.set({ active: !active });
    });
    applyDarkMode();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "analytics-event" || !message?.event) {
    return;
  }

  if (message.event === "pdf_apply") {
    recordPdfApply();
    return;
  }

  recordAnalyticsEvent(message.event);
});

// UTILS
async function applyDarkMode() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.url && (tab.url.includes(".pdf") || tab.url.includes(".PDF"))) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scripts/invert.js"],
    });
  }
}

function ensureSyncDefault(key, value) {
  chrome.storage.sync.get(key, (result) => {
    if (typeof result[key] === "undefined") {
      chrome.storage.sync.set({ [key]: value });
    }
  });
}

function ensureLocalDefault(key, value) {
  chrome.storage.local.get(key, (result) => {
    if (typeof result[key] === "undefined") {
      chrome.storage.local.set({ [key]: value });
    }
  });
}

function recordAnalyticsEvent(eventName) {
  chrome.storage.local.get("analytics", ({ analytics }) => {
    const data = analytics || { events: {}, pdfAppliesByDay: {} };
    const currentCount = data.events[eventName] || 0;
    data.events[eventName] = currentCount + 1;
    chrome.storage.local.set({ analytics: data });
  });
}

function recordPdfApply() {
  chrome.storage.local.get("analytics", ({ analytics }) => {
    const data = analytics || { events: {}, pdfAppliesByDay: {} };
    const dayKey = new Date().toISOString().slice(0, 10);
    data.pdfAppliesByDay[dayKey] = (data.pdfAppliesByDay[dayKey] || 0) + 1;
    data.events.pdfApplies = (data.events.pdfApplies || 0) + 1;
    data.pdfAppliesByDay = pruneOldDays(data.pdfAppliesByDay);
    chrome.storage.local.set({ analytics: data });
  });
}

function pruneOldDays(pdfAppliesByDay) {
  const retained = {};
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ANALYTICS_RETENTION_DAYS);

  Object.entries(pdfAppliesByDay || {}).forEach(([day, value]) => {
    if (new Date(`${day}T00:00:00.000Z`) >= cutoffDate) {
      retained[day] = value;
    }
  });

  return retained;
}
