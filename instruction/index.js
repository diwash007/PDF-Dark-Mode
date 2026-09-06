const planBadge = document.getElementById("planBadge");
const subtitle = document.querySelector(".subtitle");
const subscribeCta = document.getElementById("subscribeCta");
const secondaryCta = document.getElementById("secondaryCta");
const activateNote = document.getElementById("activateNote");

function isPaidPlan(billing) {
  return billing?.status === "active" && (billing?.plan === "pro" || billing?.plan === "lifetime");
}

chrome.storage.sync.get("billing", ({ billing }) => {
  // Guard clause: If elements don't exist on the page, don't crash the script
  if (!planBadge || !subtitle || !subscribeCta) return;

  // 1. If the user is on the FREE plan, keep default HTML or make minor tweaks
  if (!isPaidPlan(billing)) {
    // Optional: Dynamic logic for Free users on the Update page
    if (window.location.pathname.includes("update.html")) {
      secondaryCta.textContent = "View Project Changelog";
      secondaryCta.href = "https://diwashdahal.com.np/PDF-Dark-Mode#changelog";
    }
    return;
  }

  // 2. If the user is on a PAID plan (Pro / Lifetime), transform the UI dynamically:
  const planName = billing.plan === "lifetime" ? "Lifetime" : "Pro";
  planBadge.textContent = `Plan: ${planName}`;
  planBadge.classList.add("plan-badge-pro");
  
  subtitle.textContent =
    "Your Pro license is active on this browser profile. You can use all premium reading and site-rule features.";

  // Update Main CTA to a disabled "Active" state
  subscribeCta.textContent = "Pro is Active";
  subscribeCta.classList.remove("button-primary");
  subscribeCta.classList.add("button-success");
  subscribeCta.href = "#";
  subscribeCta.removeAttribute("target");
  subscribeCta.removeAttribute("rel");
  subscribeCta.setAttribute("aria-disabled", "true");
  
  // Clean event handling to prevent page jumping on click
  subscribeCta.addEventListener("click", (event) => {
    event.preventDefault();
  });

  // Update Secondary CTA based on which page they are looking at
  if (window.location.pathname.includes("update.html")) {
    secondaryCta.textContent = "View Website";
    secondaryCta.href = "https://diwashdahal.com.np/PDF-Dark-Mode"; // Or a specific changelog anchor
  } else {
    // Pro is a one-time licence — there is no subscription to manage.
    secondaryCta.textContent = "View Website";
    secondaryCta.href = "https://diwashdahal.com.np/PDF-Dark-Mode";
  }
  
  secondaryCta.target = "_blank";
  secondaryCta.rel = "noopener noreferrer";

  activateNote.innerHTML =
    "Pro features are already unlocked. If needed, you can re-activate from popup via <strong>Have a license? Activate here</strong>.";
});

// File access banner detection & settings page shortcut
const fileAccessSuccessBanner = document.getElementById("fileAccessSuccessBanner");
const fileAccessInstructions = document.getElementById("fileAccessInstructions");
const openSettingsBtn = document.getElementById("openSettingsBtn");

if (openSettingsBtn) {
  openSettingsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
}

function checkFileAccess() {
  if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => {
      if (allowed) {
        if (fileAccessSuccessBanner) fileAccessSuccessBanner.classList.remove("hidden");
        if (fileAccessInstructions) fileAccessInstructions.classList.add("hidden");
      } else {
        if (fileAccessSuccessBanner) fileAccessSuccessBanner.classList.add("hidden");
        if (fileAccessInstructions) fileAccessInstructions.classList.remove("hidden");
      }
    });
  }
}

if (fileAccessSuccessBanner || fileAccessInstructions || openSettingsBtn) {
  checkFileAccess();
  window.addEventListener("focus", checkFileAccess);
}