// update dark mode strength on slider change
let slider = document.getElementById("slider");
slider.addEventListener("change", async () => {
  chrome.storage.sync.set({ strength: slider.value });

  // inject script
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["scripts/invert.js"],
  });
});
