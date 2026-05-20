/*
 * This script runs in background and listens for tab/activity events.
 */

const ANALYTICS_RETENTION_DAYS = 35;
const LEMON_LICENSE_API_BASE = "https://api.lemonsqueezy.com/v1/licenses";
const VALIDATION_INTERVAL_HOURS = 24;

ensureSyncDefault("active", true);
ensureSyncDefault("strength", 255);
ensureSyncDefault("contrast", 100);
ensureSyncDefault("mode", "dark");
ensureSyncDefault("siteRules", {});
ensureSyncDefault("billing", defaultBilling());
ensureLocalDefault("analytics", { events: {}, pdfAppliesByDay: {} });

revalidateStoredLicenseIfNeeded();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url || !tabId) {
    return;
  }

  chrome.storage.sync.get(["active", "siteRules", "billing"], ({ active, siteRules, billing }) => {
    if (!active) return;

    const entitlement = getEntitlement(billing);
    const policy = buildUrlPolicy(tab.url, siteRules || {}, entitlement);
    if (!policy.shouldInject) return;

    recordPdfApply();
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ["scripts/invert.js"],
      })
      .catch((error) => {
        // console.error("PDF Dark Mode: failed to inject on tab update", error);
      });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("licenseValidation", { periodInMinutes: 360 });
  chrome.tabs.create({
    url: "./instruction/index.html",
  });
});

chrome.runtime.onStartup.addListener(() => {
  revalidateStoredLicenseIfNeeded();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "licenseValidation") {
    revalidateStoredLicenseIfNeeded();
  }
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "analytics-event" && message?.event) {
    recordAnalyticsEvent(message.event);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "license-activate") {
    activateLicenseFlow(message.licenseKey)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Failed to activate license." });
      });
    return true;
  }

  if (message?.type === "license-validate") {
    validateStoredLicenseFlow()
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Failed to validate license." });
      });
    return true;
  }

  sendResponse({ ok: false, error: "Unsupported message type." });
  return false;
});

async function activateLicenseFlow(inputKey) {
  const licenseKey = normalizeLicenseKey(inputKey);
  if (!licenseKey) {
    return { ok: false, error: "Please enter a valid license key." };
  }

  const currentBilling = await getSyncValue("billing");
  const billing = { ...defaultBilling(), ...(currentBilling || {}) };
  const instanceName = billing.instanceName || generateInstanceName();

  const activationPayload = await postLemonLicenseRequest("activate", {
    license_key: licenseKey,
    instance_name: instanceName,
  });

  const activation = extractActivationData(activationPayload);
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

  const validationPayload = await postLemonLicenseRequest("validate", {
    license_key: licenseKey,
    instance_id: instanceId,
  });

  const validation = extractValidationData(validationPayload);
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
    lastValidatedAt: new Date().toISOString(),
    lastValidationAttemptAt: new Date().toISOString(),
  };

  await setSyncValue("billing", nextBilling);
  return { ok: true, billing: nextBilling, message: "License activated successfully." };
}

async function validateStoredLicenseFlow() {
  const currentBilling = await getSyncValue("billing");
  const billing = { ...defaultBilling(), ...(currentBilling || {}) };
  const attemptAt = new Date().toISOString();

  const licenseKey = normalizeLicenseKey(billing.licenseKey);
  if (!licenseKey) {
    return { ok: false, error: "No license key found. Enter and activate your key first." };
  }

  if (!billing.instanceId) {
    return { ok: false, error: "No Lemon Squeezy instance ID found. Activate the license again." };
  }

  await setSyncValue("billing", {
    ...billing,
    lastValidationAttemptAt: attemptAt,
  });

  try {
    const validationPayload = await postLemonLicenseRequest("validate", {
      license_key: licenseKey,
      instance_id: billing.instanceId,
    });
    const validation = extractValidationData(validationPayload);

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

    if (!isValid) {
      return { ok: false, error: validation.error, billing: nextBilling };
    }

    return { ok: true, message: "License is valid and active.", billing: nextBilling };
  } catch (error) {
    const failedBilling = {
      ...billing,
      errorMessage: error?.message || "License validation failed.",
      lastValidationAttemptAt: attemptAt,
    };
    await setSyncValue("billing", failedBilling);
    throw error;
  }
}

async function revalidateStoredLicenseIfNeeded() {
  const currentBilling = await getSyncValue("billing");
  const billing = { ...defaultBilling(), ...(currentBilling || {}) };

  const hasLicense = !!billing.licenseKey && !!billing.instanceId;
  if (!hasLicense) {
    return;
  }

  const shouldValidateNow = !billing.lastValidationAttemptAt || isOlderThanHours(
    billing.lastValidationAttemptAt,
    VALIDATION_INTERVAL_HOURS
  );
  if (!shouldValidateNow) {
    return;
  }

  try {
    await validateStoredLicenseFlow();
  } catch (error) {
    console.error("PDF Dark Mode: automatic license validation failed", error);
    
    // Only revoke on permanent API errors (explicit rejection), not network errors
    const errorMsg = error?.message || "";
    const isPermanentError = /instance.*not found|invalid|deactivated|revoked/i.test(errorMsg);
    
    if (isPermanentError) {
      const failsafeBilling = {
        ...billing,
        plan: "free",
        status: "inactive",
        licenseStatus: "invalid",
        errorMessage: errorMsg,
        lastValidationAttemptAt: new Date().toISOString(),
      };
      await setSyncValue("billing", failsafeBilling);
    }
    // If it's a temporary error (network, timeout, etc.), keep current status and don't revoke
  }
}

function isOlderThanHours(timestamp, hours) {
  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) {
    return true;
  }
  return Date.now() - millis > hours * 60 * 60 * 1000;
}

async function postLemonLicenseRequest(endpoint, payload) {
  const response = await fetch(`${LEMON_LICENSE_API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

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

  const hasError = !!extractErrorMessage(payload, "");
  if (hasError && !instanceId) {
    return {
      ok: false,
      error: extractErrorMessage(payload, "Could not activate this license key."),
    };
  }

  if (!instanceId) {
    return {
      ok: false,
      error: "Could not determine license instance ID from activation response.",
    };
  }

  return { ok: true, instanceId };
}

function extractValidationData(payload) {
  const validFromPayload =
    payload?.valid ??
    payload?.is_valid ??
    payload?.data?.valid ??
    payload?.meta?.valid;

  const licenseStatus =
    payload?.license_key?.status ||
    payload?.data?.license_key?.status ||
    payload?.data?.attributes?.license_key?.status ||
    payload?.status ||
    "";

  const valid = typeof validFromPayload === "boolean"
    ? validFromPayload
    : /active|valid/i.test(licenseStatus);

  if (!valid) {
    return {
      valid: false,
      error: extractErrorMessage(payload, "License key is invalid or inactive."),
      status: licenseStatus,
      variantName: extractVariantName(payload),
    };
  }

  return {
    valid: true,
    error: "",
    status: licenseStatus || "active",
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
  const suffix = crypto.randomUUID().split("-")[0];
  return `pdf-dark-mode-${suffix}`;
}

async function applyDarkMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return;
  }

  chrome.storage.sync.get(["siteRules", "billing"], ({ siteRules, billing }) => {
    const entitlement = getEntitlement(billing);
    const policy = buildUrlPolicy(tab.url, siteRules || {}, entitlement);
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

function buildUrlPolicy(url, siteRules, entitlement) {
  if (!url) {
    return { shouldInject: false };
  }

  const hostname = getHostnameFromUrl(url);
  const siteRule = entitlement.isPro && hostname ? siteRules[hostname] : "";
  if (siteRule === "block") {
    return { shouldInject: false };
  }

  const isStandardPdf =
    /\.pdf($|[?#&])/i.test(url) ||
    (/^chrome-extension:\/\/[^/]+\/index\.html/i.test(url) &&
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

function getSyncValue(key) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(key, (data) => resolve(data[key]));
  });
}

function setSyncValue(key, value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [key]: value }, () => {
      resolve();
    });
  });
}
