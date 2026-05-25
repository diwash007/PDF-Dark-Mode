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
      secondaryCta.href = "https://pdf.gilobyte.com/#changelog";
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
    secondaryCta.href = "https://pdf.gilobyte.com"; // Or a specific changelog anchor
  } else {
    secondaryCta.textContent = "Manage Subscription";
    secondaryCta.href = "https://pdf.gilobyte.com/#pricing";
  }
  
  secondaryCta.target = "_blank";
  secondaryCta.rel = "noopener noreferrer";

  activateNote.innerHTML =
    "Pro features are already unlocked. If needed, you can re-activate from popup via <strong>Have a license? Activate here</strong>.";
});