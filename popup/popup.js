let slider = document.getElementById("slider");
let toggle = document.getElementById("toggle");

// update state of slider on popup
chrome.storage.sync.get("strength", ({ strength }) => {
  slider.value = strength;
});

// update state of toggle on popup
chrome.storage.sync.get("active", ({ active }) => {
  if (active) toggle.style.color = "green";
  else toggle.style.color = "red";
});

// update dark mode strength on slider change
slider.addEventListener("change", () => {
  chrome.storage.sync.set({ strength: slider.value });
  applyDarkMode();
});

// toggle active state on icon click
toggle.addEventListener("click", () => {
  chrome.storage.sync.get("active", ({ active }) => {
    console.log(active);
    if (active) {
      chrome.storage.sync.set({ active: false });
      toggle.style.color = "red";
    } else {
      chrome.storage.sync.set({ active: true });
      toggle.style.color = "green";
    }
    applyDarkMode();
  });
});

// apply dark mode if viewing PDF
async function applyDarkMode() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.url && tab.url.includes(".pdf")) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scripts/invert.js"],
    });
  }
}