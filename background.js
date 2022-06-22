let strength = 255;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ strength });
});