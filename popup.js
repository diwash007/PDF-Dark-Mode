// for slider
let alpha = document.getElementById("alpha");
alpha.addEventListener("change", async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: invertPage,
  });
});

function invertPage() {
  chrome.storage.sync.get("alpha", ({ alpha }) => {
    hexStr = alpha.toString(16);
    console.log(hexStr)

    // create a dark mode div so it can be selected dynamically on future toggles
    div = document.createElement("div");
    div.id = "darkDiv";

    let css = `
              position: fixed;
              pointer-events: none;
              top: 50px;
              left: 0;
              width: 100vw;
              height: 100vh;
              background-color: #${hexStr}eeeeee;
              mix-blend-mode: difference;
              z-index: 1; 
              `;

    // apply the dark mode to the div and append to the webpage
    div.setAttribute("style", css);
    document.body.appendChild(div);
  });
}
