/*
 * This script runs in background and listens for tab/activity events.
 */

const ANALYTICS_RETENTION_DAYS = 35;

ensureSyncDefault("active", true);
ensureSyncDefault("strength", 255);
ensureSyncDefault("contrast", 100);
ensureSyncDefault("mode", "dark");
ensureSyncDefault("siteRules", {});
ensureLocalDefault("analytics", { events: {}, pdfAppliesByDay: {} });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url || !tabId) {
    return;
  }

  chrome.storage.sync.get(["active", "siteRules"], ({ active, siteRules }) => {
    if (!active) return;

    const policy = buildUrlPolicy(tab.url, siteRules || {});
    if (!policy.shouldInject) return;

    recordPdfApply();
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ["scripts/invert.js"],
      })
      .catch((error) => {
        console.error("PDF Dark Mode: failed to inject on tab update", error);
      });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({
    url: "./instruction/index.html",
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "run-dark-mode") {
    return;
  }

  recordAnalyticsEvent("shortcutToggles");
  chrome.storage.sync.get("active", ({ active }) => {
    chrome.storage.sync.set({ active: !active }, () => {
      applyDarkMode();
    });
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "analytics-event" || !message?.event) {
    return;
  }

  recordAnalyticsEvent(message.event);
});

async function applyDarkMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return;
  }

  chrome.storage.sync.get("siteRules", ({ siteRules }) => {
    const policy = buildUrlPolicy(tab.url, siteRules || {});
    if (!policy.shouldInject) return;

    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: ["scripts/invert.js"],
      })
      .catch((error) => {
        console.error("PDF Dark Mode: failed to apply mode", error);
      });
  });
}

function buildUrlPolicy(url, siteRules) {
  if (!url) {
    return { shouldInject: false, requiresEmbeddedPreview: false };
  }

  const hostname = getHostnameFromUrl(url);
  const siteRule = hostname ? siteRules[hostname] : "";
  if (siteRule === "block") {
    return { shouldInject: false, requiresEmbeddedPreview: false };
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
    return { shouldInject: true, requiresEmbeddedPreview: false };
  }

  if (siteRule === "allow") {
    return { shouldInject: true, requiresEmbeddedPreview: false };
  }

  return { shouldInject: false, requiresEmbeddedPreview: false };
}

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
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
    data.events[eventName] = (data.events[eventName] || 0) + 1;
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
