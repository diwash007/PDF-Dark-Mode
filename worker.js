/*
 * This script is always running in background and don't have access to the curent tab
 * so it's a listener. It trigger event with sendMessage function
 */

console.log("Extension loaded!");
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.status === "complete") {
    return;
  }

  if (tab.url && tab.url.includes(".pdf")) {
    console.log("Viewing a PDF!");
    if (tabId)
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["invert.js"],
      });
  }
  // else if (tab.url && tab.url.includes("anilist.co")) {
  //     console.log("authentification !");
  //     const url = new URL(tab.url.replace("#", "?"));
  //     const urlParams = new URLSearchParams(url.search);
  //     const token = urlParams.get("access_token");
  //     if (token) {
  //         chrome.storage.sync.set({
  //             "token": token
  //         }, () => {})
  //     }
  // }

  console.log("on resolve");
  return;
});
