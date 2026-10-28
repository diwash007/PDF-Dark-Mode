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
    URL,
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

assert.equal(viewer.parsePageParam("#page=42"), 42);
assert.equal(viewer.parsePageParam("?page=7"), 7);
assert.equal(viewer.parsePageParam("?pdf=foo.pdf#page=12"), 12);
assert.equal(viewer.parsePageParam(""), 1);
assert.equal(viewer.parsePageParam("#invalid"), 1);

assert.equal(
  viewer.viewerUrlFor("https://x.com/a.pdf"),
  "viewer/viewer.html?pdf=" + encodeURIComponent("https://x.com/a.pdf")
);

/* -------------------------------------------------- file name + title */

assert.equal(viewer.fileNameOf("https://x.com/a.pdf"), "a.pdf");
assert.equal(viewer.fileNameOf("file:///path/to/my%20doc.pdf"), "my doc.pdf");
assert.equal(viewer.fileNameOf("https://x.com/doc.pdf?v=1#p=2"), "doc.pdf");
assert.equal(viewer.fileNameOf(""), "No PDF selected.");
assert.equal(viewer.fileNameOf(null), "No PDF selected.");

assert.equal(
  viewer.formatViewerTitle("a.pdf", "Full dark viewer — PDF Dark Mode"),
  "a.pdf - Full dark viewer — PDF Dark Mode"
);
assert.equal(
  viewer.formatViewerTitle("a.pdf"),
  "a.pdf - Full dark viewer — PDF Dark Mode"
);
assert.equal(
  viewer.formatViewerTitle("No PDF selected.", "Full dark viewer — PDF Dark Mode"),
  "Full dark viewer — PDF Dark Mode"
);
assert.equal(
  viewer.formatViewerTitle("", "Full dark viewer — PDF Dark Mode"),
  "Full dark viewer — PDF Dark Mode"
);
assert.equal(
  viewer.formatViewerTitle("a.pdf", "a.pdf - Full dark viewer — PDF Dark Mode"),
  "a.pdf - Full dark viewer — PDF Dark Mode"
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

/* ------------------------------------------------- render order */

assert.deepEqual(JSON.stringify(viewer.buildRenderOrder(1, 1)), JSON.stringify([1]));
assert.deepEqual(JSON.stringify(viewer.buildRenderOrder(1, 5)), JSON.stringify([1, 2, 3, 4, 5]));
assert.deepEqual(JSON.stringify(viewer.buildRenderOrder(5, 5)), JSON.stringify([5, 4, 3, 2, 1]));
assert.deepEqual(JSON.stringify(viewer.buildRenderOrder(3, 5)), JSON.stringify([3, 4, 2, 5, 1]));
assert.deepEqual(JSON.stringify(viewer.buildRenderOrder(10, 5)), JSON.stringify([5, 4, 3, 2, 1]), "out-of-range center clamps to totalPages");
assert.deepEqual(JSON.stringify(viewer.buildRenderOrder(-1, 5)), JSON.stringify([1, 2, 3, 4, 5]), "negative center clamps to 1");

/* ------------------------------------------------- highlight annotations */

const mockViewport = {
  convertToPdfPoint: (x, y) => [x * 0.75, 792 - y * 0.75],
};
const pageRect = { left: 50, top: 100 };
const clientRects = [
  { left: 100, top: 150, right: 300, bottom: 170, width: 200, height: 20 },
];

const annot = viewer.buildHighlightAnnotation(clientRects, pageRect, mockViewport, 0, [1, 0.9, 0]);
assert.ok(annot, "must create highlight annotation");
assert.equal(annot.annotationType, 9, "must be highlight annotation type");
assert.equal(annot.pageIndex, 0);
assert.equal(annot.quadPoints.length, 8, "must generate 8 quadpoints per line");
assert.equal(annot.outlines.length, 1, "must generate 1 outline polygon per line");
assert.deepEqual(JSON.stringify(annot.color), JSON.stringify([1, 0.9, 0]));
assert.equal(annot.rect.length, 4);

assert.equal(viewer.buildHighlightAnnotation([], pageRect, mockViewport), null, "empty rects returns null");
assert.equal(viewer.buildHighlightAnnotation(null, pageRect, mockViewport), null, "null rects returns null");

/* ------------------------------------------------- mergeLineRects (gap removal) */

const gappedRects = [
  { left: 100, top: 150, right: 140, bottom: 170, width: 40, height: 20 },
  { left: 148, top: 150, right: 200, bottom: 170, width: 52, height: 20 }, // 8px gap on same line
  { left: 100, top: 180, right: 250, bottom: 200, width: 150, height: 20 }, // next line
];
const merged = viewer.mergeLineRects(gappedRects);
assert.equal(merged.length, 2, "must merge 2 rects on same line into 1, leaving next line separate");
assert.equal(merged[0].left, 100);
assert.equal(merged[0].right, 200);
assert.equal(merged[0].width, 100, "merged rect spans across the gap seamlessly");
assert.equal(merged[1].top, 180);

const annotWithGaps = viewer.buildHighlightAnnotation(gappedRects, pageRect, mockViewport, 0);
assert.ok(annotWithGaps);
assert.equal(annotWithGaps.quadPoints.length, 16, "2 lines = 16 quadpoints, gap between words merged");

/* ------------------------------------------------- createAnnotationHistory (undo / redo / clear) */

const history = viewer.createAnnotationHistory();
assert.equal(history.canUndo, false);
assert.equal(history.canRedo, false);

history.recordAdd({ annotId: "a1", pageNum: 1 });
assert.equal(history.canUndo, true);
assert.equal(history.canRedo, false);

const poppedAdd = history.popUndo();
assert.equal(poppedAdd.type, "add");
assert.equal(poppedAdd.annotId, "a1");
assert.equal(history.canUndo, false);

history.pushRedo(poppedAdd);
assert.equal(history.canRedo, true);

const poppedRedo = history.popRedo();
assert.equal(poppedRedo.annotId, "a1");
assert.equal(history.canRedo, false);

history.recordDelete({ annotId: "a1", pageNum: 1 });
assert.equal(history.canUndo, true);
const poppedDel = history.popUndo();
assert.equal(poppedDel.type, "delete");

history.recordClear([{ annotId: "a1" }, { annotId: "a2" }]);
assert.equal(history.canUndo, true);
const poppedClear = history.popUndo();
assert.equal(poppedClear.type, "clearAll");
assert.equal(poppedClear.items.length, 2);

/* ------------------------------------------------- matrix & transform helpers */

assert.equal(
  JSON.stringify(viewer.multiplyMatrix([1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 10, 20])),
  JSON.stringify([1, 0, 0, 1, 10, 20]),
  "identity multiplied by translation"
);

assert.equal(
  JSON.stringify(viewer.multiplyMatrix([2, 0, 0, 3, 0, 0], [1, 0, 0, 1, 5, 10])),
  JSON.stringify([2, 0, 0, 3, 10, 30]),
  "scale multiplied by translation"
);

assert.equal(
  JSON.stringify(viewer.transformPoint([1, 0, 0, 1, 50, 100], 10, 20)),
  JSON.stringify([60, 120]),
  "transformPoint applies translation"
);

assert.equal(
  JSON.stringify(viewer.transformPoint([2, 0, 0, 3, 10, 20], 5, 10)),
  JSON.stringify([20, 50]),
  "transformPoint applies scale and translation"
);

/* ------------------------------------------------- mergeAdjacentBoxes */

assert.equal(JSON.stringify(viewer.mergeAdjacentBoxes([])), JSON.stringify([]));
assert.equal(JSON.stringify(viewer.mergeAdjacentBoxes(null)), JSON.stringify([]));

const singleBox = [{ left: 10, top: 20, width: 100, height: 80 }];
assert.equal(
  JSON.stringify(viewer.mergeAdjacentBoxes(singleBox)),
  JSON.stringify(singleBox)
);

const distinctBoxes = [
  { left: 10, top: 10, width: 50, height: 50 },
  { left: 200, top: 200, width: 80, height: 80 },
];
assert.equal(
  JSON.stringify(viewer.mergeAdjacentBoxes(distinctBoxes)),
  JSON.stringify(distinctBoxes)
);

const adjacentBoxes = [
  { left: 10, top: 10, width: 50, height: 50 },
  { left: 62, top: 10, width: 50, height: 50 }, // 2px gap <= 4px gap
];
assert.equal(
  JSON.stringify(viewer.mergeAdjacentBoxes(adjacentBoxes)),
  JSON.stringify([{ left: 10, top: 10, width: 102, height: 50 }]),
  "adjacent tiled figure strips are merged"
);

const multiTiledBoxes = [
  { left: 10, top: 10, width: 50, height: 50 },
  { left: 60, top: 10, width: 50, height: 50 },
  { left: 110, top: 10, width: 50, height: 50 },
];
assert.equal(
  JSON.stringify(viewer.mergeAdjacentBoxes(multiTiledBoxes)),
  JSON.stringify([{ left: 10, top: 10, width: 150, height: 50 }]),
  "chain of 3 adjacent tiles merges into 1 unified figure box"
);

/* ------------------------------------------------- extractImageBoxes */

const mockOPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 83,
};

const mockOpList = {
  fnArray: [
    mockOPS.save,
    mockOPS.transform,
    mockOPS.paintImageXObject,
    mockOPS.restore,
    mockOPS.save,
    mockOPS.transform,
    mockOPS.paintInlineImageXObject,
    mockOPS.restore,
  ],
  argsArray: [
    [],
    [100, 0, 0, 80, 50, 60], // width 100, height 80 at (50, 60)
    ["img_1"],
    [],
    [],
    [5, 0, 0, 5, 10, 10], // tiny width 5, height 5 (noise, should be filtered out)
    ["img_tiny"],
    [],
  ],
};

const mockVp = {
  convertToViewportPoint: (x, y) => [x, y],
};

const extracted = viewer.extractImageBoxes(mockOpList, mockVp, mockOPS);
assert.equal(extracted.length, 1, "extracts valid image and filters tiny sub-pixel noise");
assert.equal(
  JSON.stringify(extracted[0]),
  JSON.stringify({ left: 50, top: 60, width: 100, height: 80 })
);

const mockVpFallback = {
  convertToViewportRectangle: ([x1, y1, x2, y2]) => [x1, y1, x2, y2],
};
const extractedFallback = viewer.extractImageBoxes(mockOpList, mockVpFallback, mockOPS);
assert.equal(extractedFallback.length, 1, "supports convertToViewportRectangle fallback");
assert.equal(
  JSON.stringify(extractedFallback[0]),
  JSON.stringify({ left: 50, top: 60, width: 100, height: 80 })
);

/* ------------------------------------------- calculateThumbnailDimensions */

const standardA4 = viewer.calculateThumbnailDimensions(595, 842, 120);
assert.equal(standardA4.width, 120);
assert.equal(standardA4.height, 170, "A4 height scaled to 120px width is ~170px");
assert.ok(Math.abs(standardA4.scale - 120 / 595) < 0.001);

const landscapePage = viewer.calculateThumbnailDimensions(800, 600, 120);
assert.equal(landscapePage.width, 120);
assert.equal(landscapePage.height, 90, "800x600 landscape scaled to 120px width is 90px");

const fallbackDims = viewer.calculateThumbnailDimensions(0, -50, 120);
assert.equal(fallbackDims.width, 120);
assert.ok(fallbackDims.height > 0, "handles zero/negative dimensions safely");

/* ------------------------------------------------- resolveOutlineDestination */

const mockPdf = {
  async getDestination(name) {
    if (name === "ch1") return [{ num: 5, gen: 0 }, { name: "XYZ" }];
    if (name === "directPage") return [9, { name: "Fit" }];
    return null;
  },
  async getPageIndex(ref) {
    if (ref && ref.num === 5) return 4;
    return 0;
  },
};

(async () => {
  assert.equal(await viewer.resolveOutlineDestination(mockPdf, null), null);
  assert.equal(await viewer.resolveOutlineDestination(mockPdf, "nonexistent"), null);
  assert.equal(await viewer.resolveOutlineDestination(mockPdf, "ch1"), 5, "ref resolves to 1-based page 5");
  assert.equal(await viewer.resolveOutlineDestination(mockPdf, "directPage"), 10, "numeric dest resolves to page 10");
  assert.equal(
    await viewer.resolveOutlineDestination(mockPdf, [{ num: 5, gen: 0 }, { name: "XYZ" }]),
    5,
    "direct array with ref resolves to page 5"
  );
  assert.equal(
    await viewer.resolveOutlineDestination(mockPdf, [2, { name: "Fit" }]),
    3,
    "direct array with index 2 resolves to page 3"
  );
})().then(() => {
  console.log("viewer-smoke: helpers, self-exclusion and dark filter all behave");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
