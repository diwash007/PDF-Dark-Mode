/*
 * Background service worker: tab events, keyboard command, licence lifecycle.
 *
 * Policy and entitlement logic lives in scripts/core.js so the worker, the popup
 * and the content script cannot drift apart.
 */

importScripts("scripts/core.js");

const core = globalThis.PDFDarkModeCore;

const ANALYTICS_RETENTION_DAYS = 35;
const LEMON_LICENSE_API_BASE = "https://api.lemonsqueezy.com/v1/licenses";
const VALIDATION_INTERVAL_HOURS = 24;
const LICENSE_REQUEST_TIMEOUT_MS = 15000;
const LICENSE_ALARM = "licenseValidation";

const CONTENT_SCRIPT_FILES = ["scripts/core.js", "scripts/invert.js"];

/* Settings that should re-render any open PDF when they change. */
const RENDER_KEYS = [
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

const SYNC_DEFAULTS = {
  active: true,
  strength: 255,
  contrast: 100,
  mode: "dark",
  siteRules: {},
  showDock: true,
  billing: core.defaultBilling(),
};

ensureDefaults();
revalidateStoredLicenseIfNeeded();

/* ------------------------------------------------------------------ events */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url || !tabId) return;

  chrome.storage.sync.get(["active", "siteRules", "billing"], ({ active, siteRules, billing }) => {
    if (active === false) return;

    const policy = core.buildPolicy(tab.url, siteRules || {}, core.getEntitlement(billing));
    if (!policy.shouldInject) return;

    // Only count confirmed PDFs. Ambiguous URLs still get the script injected so
    // it can look for a real viewer, but they are not a reading session yet.
    if (!policy.requiresPdfEmbed) recordPdfApply();

    injectContentScript(tabId);
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureDefaults();
  ensureLicenseAlarm();

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: "./instruction/index.html" });
    return;
  }

  if (details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
    const previousVersion = details.previousVersion;
    const currentVersion = chrome.runtime.getManifest().version;
    if (previousVersion !== currentVersion) {
      chrome.tabs.create({ url: "./instruction/update.html" });
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureLicenseAlarm();
  revalidateStoredLicenseIfNeeded();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LICENSE_ALARM) revalidateStoredLicenseIfNeeded();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "run-dark-mode") return;

  recordAnalyticsEvent("shortcutToggles");
  chrome.storage.sync.get("active", ({ active }) => {
    // active defaults to true, so an undefined value toggles to false.
    chrome.storage.sync.set({ active: active === false });
    // No explicit re-render here: the storage change below fans out to every tab,
    // and the content script honours `active`, so this now actually turns off.
  });
});

/*
 * Push setting changes to every open PDF, not just the active tab. Before this,
 * changing a setting with two PDFs open only updated the one the popup was over.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!Object.keys(changes).some((key) => RENDER_KEYS.includes(key))) return;
  refreshOpenTabs();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "analytics-event" && message?.event) {
    recordAnalyticsEvent(message.event);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "open-popup") {
    chrome.action
      .openPopup()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "Failed to open popup." })
      );
    return true;
  }

  if (message?.type === "license-activate") {
    activateLicenseFlow(message.licenseKey)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "Failed to activate license." })
      );
    return true;
  }

  if (message?.type === "license-validate") {
    validateStoredLicenseFlow()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "Failed to validate license." })
      );
    return true;
  }

  sendResponse({ ok: false, error: "Unsupported message type." });
  return false;
});

/* ---------------------------------------------------------------- injection */

function injectContentScript(tabId) {
  return chrome.scripting
    .executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES })
    .catch(() => {
      /* Tab closed, navigated away, or a page we are not allowed to touch. */
    });
}

async function refreshOpenTabs() {
  const { siteRules, billing } = await chrome.storage.sync.get(["siteRules", "billing"]);
  const entitlement = core.getEntitlement(billing);

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  tabs.forEach((tab) => {
    if (!tab.id || !tab.url) return;
    if (!core.buildPolicy(tab.url, siteRules || {}, entitlement).shouldInject) return;
    injectContentScript(tab.id);
  });
}

/* ------------------------------------------------------------------ licence */

async function activateLicenseFlow(inputKey) {
  const licenseKey = normalizeLicenseKey(inputKey);
  if (!licenseKey) {
    return { ok: false, error: "Please enter a valid license key." };
  }

  const billing = { ...core.defaultBilling(), ...((await getSyncValue("billing")) || {}) };
  const instanceName = billing.instanceName || generateInstanceName();

  const activation = extractActivationData(
    await postLemonLicenseRequest("activate", {
      license_key: licenseKey,
      instance_name: instanceName,
    })
  );

  if (!activation.ok) {
    const failedBilling = {
      ...billing,
      source: "lemon-license",
      plan: "free",
      status: "inactive",
      licenseKey,
      instanceName,
      licenseStatus: "activation_failed",
      errorMessage: activation.error,
      lastValidatedAt: new Date().toISOString(),
    };
    await setSyncValue("billing", failedBilling);
    return { ok: false, error: activation.error, billing: failedBilling };
  }

  const instanceId = activation.instanceId || billing.instanceId;
  if (!instanceId) {
    return {
      ok: false,
      error: "License activated but no instance ID was returned by Lemon Squeezy.",
    };
  }

  const validation = extractValidationData(
    await postLemonLicenseRequest("validate", {
      license_key: licenseKey,
      instance_id: instanceId,
    })
  );

  if (!validation.valid) {
    const invalidBilling = {
      ...billing,
      source: "lemon-license",
      plan: "free",
      status: "inactive",
      licenseKey,
      instanceId,
      instanceName,
      licenseStatus: "invalid",
      errorMessage: validation.error,
      lastValidatedAt: new Date().toISOString(),
    };
    await setSyncValue("billing", invalidBilling);
    return { ok: false, error: validation.error, billing: invalidBilling };
  }

  const now = new Date().toISOString();
  const nextBilling = {
    ...billing,
    source: "lemon-license",
    status: "active",
    plan: resolvePlanFromValidation(validation),
    licenseKey,
    instanceId,
    instanceName,
    licenseStatus: "valid",
    errorMessage: "",
    lastValidatedAt: now,
    lastValidationAttemptAt: now,
  };

  await setSyncValue("billing", nextBilling);
  return { ok: true, billing: nextBilling, message: "License activated successfully." };
}

async function validateStoredLicenseFlow() {
  const billing = { ...core.defaultBilling(), ...((await getSyncValue("billing")) || {}) };
  const attemptAt = new Date().toISOString();

  const licenseKey = normalizeLicenseKey(billing.licenseKey);
  if (!licenseKey) {
    return { ok: false, error: "No license key found. Enter and activate your key first." };
  }
  if (!billing.instanceId) {
    return { ok: false, error: "No Lemon Squeezy instance ID found. Activate the license again." };
  }

  await setSyncValue("billing", { ...billing, lastValidationAttemptAt: attemptAt });

  try {
    const validation = extractValidationData(
      await postLemonLicenseRequest("validate", {
        license_key: licenseKey,
        instance_id: billing.instanceId,
      })
    );

    const isValid = validation.valid;
    const nextBilling = {
      ...billing,
      source: "lemon-license",
      status: isValid ? "active" : "inactive",
      plan: isValid ? resolvePlanFromValidation(validation) : "free",
      licenseStatus: isValid ? "valid" : "invalid",
      errorMessage: isValid ? "" : validation.error,
      lastValidatedAt: new Date().toISOString(),
      lastValidationAttemptAt: attemptAt,
    };

    await setSyncValue("billing", nextBilling);

    return isValid
      ? { ok: true, message: "License is valid and active.", billing: nextBilling }
      : { ok: false, error: validation.error, billing: nextBilling };
  } catch (error) {
    await setSyncValue("billing", {
      ...billing,
      errorMessage: error?.message || "License validation failed.",
      lastValidationAttemptAt: attemptAt,
    });
    throw error;
  }
}

async function revalidateStoredLicenseIfNeeded() {
  const billing = { ...core.defaultBilling(), ...((await getSyncValue("billing")) || {}) };

  if (!billing.licenseKey || !billing.instanceId) return;

  const due =
    !billing.lastValidationAttemptAt ||
    isOlderThanHours(billing.lastValidationAttemptAt, VALIDATION_INTERVAL_HOURS);
  if (!due) return;

  try {
    await validateStoredLicenseFlow();
  } catch (error) {
    console.error("PDF Dark Mode: automatic license validation failed", error);

    // Only revoke when Lemon Squeezy explicitly rejected the licence. Network
    // failures and timeouts must never cost a paying user their Pro features.
    const message = error?.message || "";
    const isPermanent = /instance.*not found|invalid|deactivated|revoked/i.test(message);
    if (!isPermanent) return;

    await setSyncValue("billing", {
      ...billing,
      plan: "free",
      status: "inactive",
      licenseStatus: "invalid",
      errorMessage: message,
      lastValidationAttemptAt: new Date().toISOString(),
    });
  }
}

function ensureLicenseAlarm() {
  chrome.alarms.get(LICENSE_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(LICENSE_ALARM, { periodInMinutes: 360 });
  });
}

function isOlderThanHours(timestamp, hours) {
  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) return true;
  return Date.now() - millis > hours * 60 * 60 * 1000;
}

async function postLemonLicenseRequest(endpoint, payload) {
  let response;
  try {
    response = await fetch(`${LEMON_LICENSE_API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      // Without this a hung request left the popup's Activate button disabled
      // forever, with no way back except closing and reopening it.
      signal: AbortSignal.timeout(LICENSE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("License server timed out. Check your connection and try again.");
    }
    throw new Error("Could not reach the license server. Check your connection and try again.");
  }

  const rawBody = await response.text();
  let data = {};
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error("License API returned an invalid response.");
    }
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(data, `License API request failed (${response.status}).`));
  }

  return data;
}

function extractActivationData(payload) {
  const instanceId =
    payload?.instance_id ||
    payload?.instance?.id ||
    payload?.data?.instance_id ||
    payload?.data?.id ||
    payload?.data?.instance?.id ||
    payload?.meta?.instance_id ||
    payload?.meta?.instance?.id ||
    "";

  if (!instanceId) {
    const message = extractErrorMessage(payload, "");
    return {
      ok: false,
      error:
        message ||
        "Could not determine license instance ID from activation response.",
    };
  }

  return { ok: true, instanceId };
}

function extractValidationData(payload) {
  const validFromPayload =
    payload?.valid ?? payload?.is_valid ?? payload?.data?.valid ?? payload?.meta?.valid;

  const licenseStatus =
    payload?.license_key?.status ||
    payload?.data?.license_key?.status ||
    payload?.data?.attributes?.license_key?.status ||
    payload?.status ||
    "";

  const valid =
    typeof validFromPayload === "boolean" ? validFromPayload : /active|valid/i.test(licenseStatus);

  return {
    valid,
    error: valid ? "" : extractErrorMessage(payload, "License key is invalid or inactive."),
    status: licenseStatus || (valid ? "active" : ""),
    variantName: extractVariantName(payload),
  };
}

function extractVariantName(payload) {
  return (
    payload?.meta?.variant_name ||
    payload?.data?.variant_name ||
    payload?.data?.attributes?.variant_name ||
    payload?.license_key?.variant_name ||
    payload?.data?.license_key?.variant_name ||
    ""
  );
}

function resolvePlanFromValidation(validation) {
  return /lifetime/i.test(validation?.variantName || "") ? "lifetime" : "pro";
}

function extractErrorMessage(payload, fallback) {
  const fromErrorList = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  return (
    payload?.error ||
    payload?.message ||
    payload?.meta?.error ||
    fromErrorList?.detail ||
    fromErrorList?.title ||
    fallback
  );
}

function normalizeLicenseKey(value) {
  return (value || "").trim().toUpperCase();
}

function generateInstanceName() {
  return `pdf-dark-mode-${crypto.randomUUID().split("-")[0]}`;
}

/* ---------------------------------------------------------------- storage */

function ensureDefaults() {
  const keys = Object.keys(SYNC_DEFAULTS);
  chrome.storage.sync.get(keys, (result) => {
    if (chrome.runtime.lastError) return;

    const missing = {};
    keys.forEach((key) => {
      if (typeof result[key] === "undefined") missing[key] = SYNC_DEFAULTS[key];
    });

    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });

  chrome.storage.local.get("analytics", ({ analytics }) => {
    if (typeof analytics === "undefined") {
      chrome.storage.local.set({ analytics: { events: {}, pdfAppliesByDay: {} } });
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
  const cutoff = Date.now() - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const retained = {};

  Object.entries(pdfAppliesByDay || {}).forEach(([day, value]) => {
    const timestamp = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isNaN(timestamp) && timestamp >= cutoff) retained[day] = value;
  });

  return retained;
}

function getSyncValue(key) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(key, (data) => resolve(data[key]));
  });
}

function setSyncValue(key, value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [key]: value }, () => resolve());
  });
}
