// for slider
let slider = document.getElementById("slider");
slider.addEventListener("change", async () => {
  let strength = slider.value;
  chrome.storage.sync.set({ strength });
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: invertPage,
  });
});


function invertPage() {

  chrome.storage.sync.get("strength", ({ strength }) => {
    let hexStr = parseInt(strength, 10).toString(16)

    // create a dark mode div
    div = document.getElementById("darkDiv");
    if (!div) {
      div = document.createElement("div");
      div.id = "darkDiv";
    }

    let css = `
              position: fixed;
              pointer-events: none;
              top: 50px;
              left: 0;
              width: 100vw;
              height: 100vh;
              background-color: #${hexStr}ffffff;
              mix-blend-mode: difference;
              z-index: 1; 
              `;

    // apply the dark mode to the div and append to the webpage
    div.setAttribute("style", css);
    document.body.appendChild(div);
  });
}

