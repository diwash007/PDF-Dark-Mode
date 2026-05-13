const DARK_LAYER_ID = "darkDiv";
const TINT_LAYER_ID = "tintDiv";

chrome.storage.sync.get("active", ({ active }) => {
  if (!active) {
    removeLayer(DARK_LAYER_ID);
    removeLayer(TINT_LAYER_ID);
    return;
  }

  chrome.storage.sync.get(["strength", "contrast", "mode"], (settings) => {
    removeLayer(DARK_LAYER_ID);
    removeLayer(TINT_LAYER_ID);

    const strength = clamp(Number(settings.strength) || 255, 200, 255);
    const contrast = clamp(Number(settings.contrast) || 100, 50, 130);
    const mode = settings.mode || "dark";
    const strengthHex = strength.toString(16).padStart(2, "0");

    const darkLayer = document.createElement("div");
    darkLayer.id = DARK_LAYER_ID;

    const blendStrengthHex = mode === "amoled" ? "ff" : strengthHex;
    const contrastValue = mode === "amoled" ? Math.max(contrast, 110) : contrast;
    const brightnessValue = mode === "amoled" ? 78 : 100;

    darkLayer.setAttribute(
      "style",
      `
        position: fixed;
        pointer-events: none;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background-color: #${blendStrengthHex}ffffff;
        mix-blend-mode: difference;
        z-index: 2147483646;
        filter: contrast(${contrastValue}%) brightness(${brightnessValue}%);
      `
    );

    document.body.appendChild(darkLayer);

    if (mode === "sepia") {
      const tintLayer = document.createElement("div");
      tintLayer.id = TINT_LAYER_ID;
      tintLayer.setAttribute(
        "style",
        `
          position: fixed;
          pointer-events: none;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background-color: rgba(112, 66, 20, 0.2);
          mix-blend-mode: multiply;
          z-index: 2147483647;
        `
      );
      document.body.appendChild(tintLayer);
    }

    chrome.runtime.sendMessage({ type: "analytics-event", event: "pdf_apply" });
  });
});

function removeLayer(id) {
  const layer = document.getElementById(id);
  if (layer) {
    layer.remove();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
