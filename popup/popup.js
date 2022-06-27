let slider = document.getElementById("slider");
let toggle = document.getElementById("toggle");
let contrastSlider = document.getElementById("contrastSlider");

// update state of slider on popup
chrome.storage.sync.get("strength", ({ strength }) => {
  slider.value = strength;
});

// update state of contrast on popup
chrome.storage.sync.get("contrast", ({ contrast }) => {
  contrastSlider.value = contrast;
});

// update state of toggle on popup
chrome.storage.sync.get("active", ({ active }) => {
  if (active) toggle.style.color = "lime";
  else toggle.style.color = "red";
});

// update dark mode strength on slider change
slider.addEventListener("change", () => {
  chrome.storage.sync.set({ strength: slider.value });
  applyDarkMode();
});

// update contrast on slider change
contrastSlider.addEventListener("change", () => {
  chrome.storage.sync.set({ contrast: contrastSlider.value });
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
    applyDarkMode();
  });
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
