chrome.storage.sync.get("active", ({ active }) => {
  div = document.getElementById("darkDiv");
  if (active) {
    chrome.storage.sync.get(
      ["strength", "contrast"],
      ({ strength, contrast }) => {
        hexStr = parseInt(strength, 10).toString(16);

        // create a dark mode div if it doesn't exist
        if (!div) {
          div = document.createElement("div");
          div.id = "darkDiv";
        }

        let css = `
            position: fixed;
            pointer-events: none;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: #${hexStr}ffffff;
            mix-blend-mode: difference;
            z-index: 1;
            filter: contrast(${contrast}%);
            `;

        // apply the dark mode to the div and append to the page
        div.setAttribute("style", css);
        document.body.appendChild(div);
      }
    );
  } else {
    div.remove();
  }
});
