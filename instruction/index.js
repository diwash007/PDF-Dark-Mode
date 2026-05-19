const planBadge = document.getElementById("planBadge");
const subtitle = document.querySelector(".subtitle");
const subscribeCta = document.getElementById("subscribeCta");
const secondaryCta = document.getElementById("secondaryCta");
const activateNote = document.getElementById("activateNote");

function isPaidPlan(billing) {
  return billing?.status === "active" && (billing?.plan === "pro" || billing?.plan === "lifetime");
}

chrome.storage.sync.get("billing", ({ billing }) => {
  if (!isPaidPlan(billing)) {
    return;
  }

  const planName = billing.plan === "lifetime" ? "Lifetime" : "Pro";
  planBadge.textContent = `Plan: ${planName}`;
  planBadge.classList.add("plan-badge-pro");
  subtitle.textContent =
    "Your Pro license is active on this browser profile. You can use all premium reading and site-rule features.";

  subscribeCta.textContent = "Pro is Active";
  subscribeCta.classList.remove("button-primary");
  subscribeCta.classList.add("button-success");
  subscribeCta.href = "#";
  subscribeCta.removeAttribute("target");
  subscribeCta.removeAttribute("rel");
  subscribeCta.setAttribute("aria-disabled", "true");
  subscribeCta.addEventListener("click", (event) => event.preventDefault());

  secondaryCta.textContent = "Manage Subscription";
  secondaryCta.href = "https://diwashdahal.com.np/PDF-Dark-Mode/#pricing";
  secondaryCta.target = "_blank";
  secondaryCta.rel = "noopener noreferrer";

  activateNote.innerHTML =
    "Pro features are already unlocked. If needed, you can re-activate from popup via <strong>Have a license? Activate here</strong>.";
});
