/*
 * Full-dark viewer behaviour: URL helpers, viewer self-exclusion from the
 * overlay policy, and the canvas dark filter mapping.
 *
 * Run: node tests/viewer-smoke.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const core = require("../scripts/core.js");
const viewerSrc = fs.readFileSync(path.join(root, "viewer/viewer.js"), "utf8");

function loadViewer() {
  const sandbox = {
    globalThis: {},
    module: { exports: {} },
    URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(viewerSrc, { filename: "viewer/viewer.js" }).runInContext(sandbox);
  return sandbox.PDFDarkModeViewer;
}

const viewer = loadViewer();
assert.ok(viewer, "viewer.js must expose PDFDarkModeViewer");

const FREE = { isPro: false };
const PRO = { isPro: true };

/* ------------------------------------------------- param + URL helpers */

assert.equal(viewer.parsePdfParam("?pdf=https%3A%2F%2Fx.com%2Fa.pdf"), "https://x.com/a.pdf");
assert.equal(viewer.parsePdfParam(""), "");
assert.equal(viewer.parsePdfParam("?other=1"), "");

assert.equal(
  viewer.viewerUrlFor("https://x.com/a.pdf"),
  "viewer/viewer.html?pdf=" + encodeURIComponent("https://x.com/a.pdf")
);

/* ---------------------------------------------------------- PDF magic */

assert.equal(viewer.isPdfMagic(Buffer.from("%PDF-1.7 rest")), true);
assert.equal(viewer.isPdfMagic(Buffer.from("<html>nope")), false);
assert.equal(viewer.isPdfMagic(new Uint8Array(0)), false);

/* --------------------------------------- viewer never takes the overlay */

const viewerUrl = "chrome-extension://abcdefghijklmnop/viewer/viewer.html?pdf=" +
  encodeURIComponent("https://arxiv.org/pdf/a.pdf");

assert.equal(viewer.isViewerUrl(viewerUrl), true);
assert.equal(viewer.isViewerUrl("https://arxiv.org/pdf/a.pdf"), false);
assert.equal(core.isViewerUrl(viewerUrl), true);

assert.deepEqual(core.buildPolicy(viewerUrl, {}, FREE), {
  shouldInject: false,
  requiresPdfEmbed: false,
});
assert.deepEqual(core.buildPolicy(viewerUrl, {}, PRO), {
  shouldInject: false,
  requiresPdfEmbed: false,
});

// Ordinary PDFs still inject.
assert.equal(core.buildPolicy("https://arxiv.org/pdf/a.pdf", {}, FREE).shouldInject, true);

/* ------------------------------------------------------ dark filter */

const freeFilter = viewer.buildViewerFilter({ darkEnabled: true });
assert.match(freeFilter, /invert\(100%\)/, "default strength 255 inverts fully");
assert.match(freeFilter, /hue-rotate\(180deg\)/, "hue must rotate back");
assert.match(freeFilter, /contrast\(100%\)/);

assert.equal(viewer.buildViewerFilter({ darkEnabled: false }), "", "dark off means no filter");

const weak = viewer.buildViewerFilter({ strength: 200, darkEnabled: true });
assert.match(weak, /invert\(78%\)/, "strength 200 softens the inversion");

const freeSepia = viewer.buildViewerFilter({ mode: "sepia", isPro: false, darkEnabled: true });
assert.ok(!freeSepia.includes("sepia"), "free plan cannot get sepia in the viewer");

const proSepia = viewer.buildViewerFilter({ mode: "sepia", isPro: true, darkEnabled: true });
assert.match(proSepia, /sepia\(25%\)/, "pro sepia tints the canvas");

const proAmoled = viewer.buildViewerFilter({ mode: "amoled", isPro: true, darkEnabled: true });
assert.match(proAmoled, /brightness\(78%\)/, "amoled pushes brightness like core.js");

assert.ok(viewer.MAX_PDF_BYTES > 0, "viewer must cap PDF size");

/* ------------------------------------------------- HiDPI canvas size */

const viewport = { width: 612.5, height: 792.5 };

// NOTE: viewer.js executes in its own vm realm, so its objects/arrays fail a
// strict prototype comparison — compare via JSON like worker-smoke does.
const sized = (viewportArg, dpr) =>
  JSON.stringify(viewer.canvasSizeForViewport(viewportArg, dpr));

assert.equal(
  sized(viewport, 1),
  JSON.stringify({
    width: 612,
    height: 792,
    styleWidth: "612px",
    styleHeight: "792px",
    transform: null,
  }),
  "DPR 1 renders at CSS pixels with no transform"
);

assert.equal(
  sized(viewport, 2),
  JSON.stringify({
    width: 1225,
    height: 1585,
    styleWidth: "612px",
    styleHeight: "792px",
    transform: [2, 0, 0, 2, 0, 0],
  }),
  "DPR 2 doubles the backing store while CSS size stays locked"
);

const fractional = viewer.canvasSizeForViewport(viewport, 1.25);
assert.equal(fractional.styleWidth, "612px", "fractional DPR never changes layout size");
assert.equal(fractional.width, Math.floor(612.5 * 1.25), "fractional DPR scales the bitmap");
assert.equal(JSON.stringify(fractional.transform), JSON.stringify([1.25, 0, 0, 1.25, 0, 0]));

assert.equal(
  sized(viewport, 0),
  sized(viewport, 1),
  "missing DPR falls back to 1, never a zero-size canvas"
);

/* ------------------------------------------------- background themes */

assert.equal(viewer.DEFAULT_VIEWER_THEME, "charcoal", "default theme must be dark, not gray");
assert.ok(
  Array.isArray(viewer.BACKGROUND_THEMES) && viewer.BACKGROUND_THEMES.length >= 2,
  "viewer must offer background theme choices"
);
viewer.BACKGROUND_THEMES.forEach((theme) => {
  assert.ok(theme.id && theme.bg && theme.chrome, "every theme needs bg + chrome colors");
  assert.ok(!/525659|323639/i.test(theme.bg + theme.chrome), `theme ${theme.id} must not be native-viewer gray`);
});

assert.equal(viewer.resolveViewerTheme("charcoal", false).id, "charcoal");
assert.equal(viewer.resolveViewerTheme("midnight", false).id, "midnight");
assert.equal(
  viewer.resolveViewerTheme("amoled", false).id,
  "charcoal",
  "free plan falls back to charcoal on Pro themes"
);
assert.equal(viewer.resolveViewerTheme("amoled", true).id, "amoled", "pro unlocks amoled");
assert.equal(viewer.resolveViewerTheme("nope", true).id, "charcoal", "unknown themes fall back");
assert.equal(viewer.resolveViewerTheme(undefined, false).id, "charcoal", "missing pref falls back");

console.log("viewer-smoke: helpers, self-exclusion and dark filter all behave");
