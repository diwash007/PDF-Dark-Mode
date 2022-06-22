let alpha = 255;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ alpha });
});