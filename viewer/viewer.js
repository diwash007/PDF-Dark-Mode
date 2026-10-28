/*
 * Full-dark PDF viewer. Opened as viewer/viewer.html?pdf=<encoded PDF url>
 * from the popup or the on-page dock. Fully local: the PDF is fetched from
 * the extension origin (proven by spike/probe.js for https and file:// with
 * file access on) and rendered with vendored pdf.js — no CDN, no uploads.
 *
 * Classic script (no static imports) so the integrity parse check passes;
 * the ESM-only vendored pdf.js loads via dynamic import(), same as ai/ai.js.
 *
 * Pure helpers are exposed on globalThis.PDFDarkModeViewer for tests. The DOM
 * boot is guarded so the file can be executed in a stub environment.
 */

(() => {
  const MAX_PDF_BYTES = 150 * 1024 * 1024;
  const PDF_MAGIC = "%PDF-";
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 4;
  // Default render scale; the zoom label is relative to it, so the default
  // view reads as 100%.
  const DEFAULT_SCALE = 1.24;
  const DEFAULT_VIEWER_THEME = "charcoal";

  const BACKGROUND_THEMES = [
    { id: "charcoal", name: "Charcoal", bg: "#111827", chrome: "#1f2937", isPro: false },
    { id: "midnight", name: "Midnight", bg: "#0b0f16", chrome: "#151b26", isPro: false },
    { id: "amoled", name: "AMOLED", bg: "#000000", chrome: "#0a0a0a", isPro: true },
    { id: "warm", name: "Warm", bg: "#1c1917", chrome: "#292524", isPro: true },
  ];

  function parsePdfParam(search) {
    try {
      return new URLSearchParams(search || "").get("pdf") || "";
    } catch {
      return "";
    }
  }

  function parsePageParam(locationSearchOrHash) {
    if (!locationSearchOrHash || typeof locationSearchOrHash !== "string") return 1;
    try {
      const match = locationSearchOrHash.match(/[#?&]page=(\d+)/i);
      if (match) {
        const p = parseInt(match[1], 10);
        return p > 0 ? p : 1;
      }
    } catch {
      /* ignore */
    }
    return 1;
  }

  function viewerUrlFor(pdfUrl) {
    return "viewer/viewer.html?pdf=" + encodeURIComponent(pdfUrl || "");
  }

  function isPdfMagic(bytes) {
    if (!bytes || bytes.length < 5) return false;
    let magic = "";
    for (let i = 0; i < 5; i += 1) magic += String.fromCharCode(bytes[i]);
    return magic === PDF_MAGIC;
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
  }

  /*
   * Priority render ordering: renders the user's current/target page first,
   * then radiates outward (page + 1, page - 1, page + 2, page - 2, ...).
   * This ensures that on initial jump or reload of a long PDF, the visible
   * page appears immediately rather than waiting for preceding pages.
   */
  function buildRenderOrder(centerPage, totalPages) {
    if (!Number.isFinite(totalPages) || totalPages < 1) return [];
    const center = clampNumber(centerPage, 1, totalPages, 1);
    const order = [];
    const seen = new Set();
    const add = (p) => {
      if (p >= 1 && p <= totalPages && !seen.has(p)) {
        seen.add(p);
        order.push(p);
      }
    };
    add(center);
    for (let offset = 1; order.length < totalPages; offset += 1) {
      add(center + offset);
      add(center - offset);
    }
    return order;
  }

  /*
   * Merges fragmented client rects on the same line into continuous line rects.
   * Eliminates awkward gaps between adjacent word spans.
   */
  function mergeLineRects(clientRects) {
    if (!Array.isArray(clientRects) || !clientRects.length) return [];
    const rects = clientRects
      .filter((r) => r && r.width > 0 && r.height > 0)
      .map((r) => ({
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      }));
    if (rects.length <= 1) return rects;

    rects.sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));

    const merged = [];
    let current = { ...rects[0] };

    for (let i = 1; i < rects.length; i++) {
      const next = rects[i];
      const sameLine =
        Math.abs(current.top - next.top) <= Math.max(current.height, next.height) * 0.5 &&
        Math.abs(current.bottom - next.bottom) <= Math.max(current.height, next.height) * 0.5;

      const maxGap = Math.max(current.height, next.height) * 1.2;
      const horizontallyClose =
        next.left >= current.left && next.left - current.right <= maxGap;

      if (sameLine && horizontallyClose) {
        current.right = Math.max(current.right, next.right);
        current.top = Math.min(current.top, next.top);
        current.bottom = Math.max(current.bottom, next.bottom);
        current.left = Math.min(current.left, next.left);
        current.width = current.right - current.left;
        current.height = current.bottom - current.top;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
    return merged;
  }

  /*
   * Converts client selection rects into a standard PDF Highlight annotation
   * with quadPoints, outlines, and bounding rect in PDF point space.
   */
  function buildHighlightAnnotation(clientRects, pageRect, viewport, pageIndex = 0, color = [1, 0.9, 0]) {
    if (!Array.isArray(clientRects) || !clientRects.length || !viewport || !pageRect) return null;

    const mergedRects = mergeLineRects(clientRects);
    if (!mergedRects.length) return null;

    const quadPoints = [];
    const outlines = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    mergedRects.forEach((rect) => {
      if (rect.width < 1 || rect.height < 1) return;
      const vx1 = rect.left - pageRect.left;
      const vy1 = rect.top - pageRect.top;
      const vx2 = rect.right - pageRect.left;
      const vy2 = rect.bottom - pageRect.top;

      const [p1x, p1y] = viewport.convertToPdfPoint(vx1, vy1);
      const [p2x, p2y] = viewport.convertToPdfPoint(vx2, vy2);

      const left = Math.min(p1x, p2x);
      const right = Math.max(p1x, p2x);
      const bottom = Math.min(p1y, p2y);
      const top = Math.max(p1y, p2y);

      minX = Math.min(minX, left);
      minY = Math.min(minY, bottom);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, top);

      quadPoints.push(left, top, right, top, left, bottom, right, bottom);
      outlines.push([left, top, right, top, right, bottom, left, bottom]);
    });

    if (!quadPoints.length) return null;

    return {
      annotationType: 9, // HIGHLIGHT
      color,
      opacity: 0.5,
      quadPoints,
      outlines,
      rect: [minX, minY, maxX, maxY],
      pageIndex,
      rotation: 0,
      date: new Date(),
    };
  }

  /*
   * HiDPI canvas sizing (official pdf.js recipe): the backing store renders
   * at device pixels while CSS size stays at viewport pixels, so the browser
   * never upscales the bitmap — that upscale was the viewer's blurriness.
   * Rendering without this (canvas.width = viewport.width) looks soft on any
   * HiDPI or >100%-scaled display next to the native viewer.
   */
  function canvasSizeForViewport(viewport, outputScale) {
    const scale = Number.isFinite(outputScale) && outputScale > 0 ? outputScale : 1;
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);
    return {
      width: Math.floor(viewport.width * scale),
      height: Math.floor(viewport.height * scale),
      styleWidth: `${width}px`,
      styleHeight: `${height}px`,
      transform: scale !== 1 ? [scale, 0, 0, scale, 0, 0] : null,
    };
  }

  /*
   * CSS filter implementing "full dark": the rendered page canvas genuinely
   * inverts (white -> black), unlike the overlay which cannot reach pixels in
   * Chrome's native viewer process. Strength maps to invert amount, contrast
   * passes through, AMOLED pushes contrast/brightness like core.js does.
   */
  function buildViewerFilter(options) {
    const opts = options || {};
    if (opts.darkEnabled === false) return "";
    const mode = opts.isPro ? opts.mode || "dark" : "dark";
    const resolved = mode === "sepia" || mode === "amoled" ? mode : "dark";
    const strength = clampNumber(opts.strength, 200, 255, 255);
    const contrast = clampNumber(opts.contrast, 50, 130, 100);

    const invertPct = Math.round((strength / 255) * 100);
    const contrastPct = resolved === "amoled" ? Math.max(contrast, 110) : contrast;

    let filter = `invert(${invertPct}%) hue-rotate(180deg) contrast(${contrastPct}%)`;
    if (resolved === "amoled") filter += " brightness(78%)";
    if (resolved === "sepia") filter += " sepia(25%)";
    return filter;
  }

  function resolveViewerTheme(themeId, isPro) {
    const found = BACKGROUND_THEMES.find((theme) => theme.id === themeId);
    if (!found) return BACKGROUND_THEMES[0];
    if (found.isPro && !isPro) return BACKGROUND_THEMES[0];
    return found;
  }

  function isFileUrl(url) {
    return /^file:\/\//i.test(url || "");
  }

  function isViewerUrl(url) {
    return /\/viewer\/viewer\.html/i.test(url || "");
  }

  function fileNameOf(url) {
    if (!url) return "No PDF selected.";
    try {
      const pathname = new URL(url).pathname;
      const base = decodeURIComponent(pathname.split("/").pop() || "");
      return base || url;
    } catch {
      return url;
    }
  }

  function formatViewerTitle(fileName, baseTitle) {
    const fallback = "Full dark viewer — PDF Dark Mode";
    const base = (typeof baseTitle === "string" && baseTitle.trim()) || fallback;
    if (!fileName || fileName === "No PDF selected.") {
      return base;
    }
    if (base.startsWith(`${fileName} - `)) {
      return base;
    }
    return `${fileName} - ${base}`;
  }

  /*
   * Manages an undo/redo stack for highlight annotations.
   */
  function createAnnotationHistory() {
    const undoStack = [];
    const redoStack = [];

    return {
      get canUndo() {
        return undoStack.length > 0;
      },
      get canRedo() {
        return redoStack.length > 0;
      },
      undoStack,
      redoStack,
      recordAdd(record) {
        undoStack.push({ type: "add", ...record });
        redoStack.length = 0;
      },
      recordDelete(record) {
        undoStack.push({ type: "delete", ...record });
        redoStack.length = 0;
      },
      recordClear(items) {
        undoStack.push({ type: "clearAll", items: [...items] });
        redoStack.length = 0;
      },
      popUndo() {
        return undoStack.length ? undoStack.pop() : null;
      },
      pushRedo(action) {
        redoStack.push(action);
      },
      popRedo() {
        return redoStack.length ? redoStack.pop() : null;
      },
      pushUndo(action) {
        undoStack.push(action);
      },
      clear() {
        undoStack.length = 0;
        redoStack.length = 0;
      },
    };
  }

  /* Multiplies two 2D affine transformation matrices [a, b, c, d, e, f]. */
  function multiplyMatrix(m1, m2) {
    if (!Array.isArray(m1) || !Array.isArray(m2)) return [1, 0, 0, 1, 0, 0];
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  /* Transforms a 2D point (x, y) by an affine matrix [a, b, c, d, e, f]. */
  function transformPoint(m, x, y) {
    if (!Array.isArray(m) || m.length < 6) return [x, y];
    return [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];
  }

  /*
   * Merges bounding boxes of adjacent or overlapping image chunks (such as
   * LaTeX/scientific paper tiled figures) to prevent hairline seam artifacts.
   */
  function mergeAdjacentBoxes(boxes, gap = 4) {
    if (!Array.isArray(boxes) || boxes.length <= 1) return boxes ? [...boxes] : [];
    const list = boxes
      .filter((b) => b && b.width > 0 && b.height > 0)
      .map((b) => ({
        left: b.left,
        top: b.top,
        right: b.left + b.width,
        bottom: b.top + b.height,
      }));

    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const overlapX = a.left - gap <= b.right && b.left - gap <= a.right;
          const overlapY = a.top - gap <= b.bottom && b.top - gap <= a.bottom;
          if (overlapX && overlapY) {
            a.left = Math.min(a.left, b.left);
            a.top = Math.min(a.top, b.top);
            a.right = Math.max(a.right, b.right);
            a.bottom = Math.max(a.bottom, b.bottom);
            list.splice(j, 1);
            merged = true;
            break;
          }
        }
        if (merged) break;
      }
    }

    return list.map((b) => ({
      left: b.left,
      top: b.top,
      width: b.right - b.left,
      height: b.bottom - b.top,
    }));
  }

  /*
   * Extracts image bounding boxes from a PDF.js operator list in viewport coordinates.
   */
  function extractImageBoxes(opList, viewport, OPS) {
    if (!opList || !Array.isArray(opList.fnArray) || !viewport || !OPS) return [];
    const boxes = [];
    const matrixStack = [];
    let currentMatrix = [1, 0, 0, 1, 0, 0];

    const imageOps = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ]);

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.save) {
        matrixStack.push(currentMatrix.slice());
      } else if (fn === OPS.restore) {
        currentMatrix = matrixStack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
        currentMatrix = multiplyMatrix(currentMatrix, args);
      } else if (imageOps.has(fn)) {
        const p0 = transformPoint(currentMatrix, 0, 0);
        const p1 = transformPoint(currentMatrix, 1, 0);
        const p2 = transformPoint(currentMatrix, 0, 1);
        const p3 = transformPoint(currentMatrix, 1, 1);

        const minX = Math.min(p0[0], p1[0], p2[0], p3[0]);
        const minY = Math.min(p0[1], p1[1], p2[1], p3[1]);
        const maxX = Math.max(p0[0], p1[0], p2[0], p3[0]);
        const maxY = Math.max(p0[1], p1[1], p2[1], p3[1]);

        if (typeof viewport.convertToViewportPoint === "function") {
          const [vx1, vy1] = viewport.convertToViewportPoint(minX, minY);
          const [vx2, vy2] = viewport.convertToViewportPoint(maxX, maxY);
          const left = Math.floor(Math.min(vx1, vx2));
          const top = Math.floor(Math.min(vy1, vy2));
          const width = Math.ceil(Math.abs(vx2 - vx1));
          const height = Math.ceil(Math.abs(vy2 - vy1));

          // Filter out sub-pixel lines, hairline borders, or tiny spacers:
          if (width >= 20 && height >= 20) {
            boxes.push({ left, top, width, height });
          }
        } else if (typeof viewport.convertToViewportRectangle === "function") {
          const rect = viewport.convertToViewportRectangle([minX, minY, maxX, maxY]);
          const left = Math.floor(Math.min(rect[0], rect[2]));
          const top = Math.floor(Math.min(rect[1], rect[3]));
          const width = Math.ceil(Math.abs(rect[2] - rect[0]));
          const height = Math.ceil(Math.abs(rect[3] - rect[1]));

          // Filter out sub-pixel lines, hairline borders, or tiny spacers:
          if (width >= 20 && height >= 20) {
            boxes.push({ left, top, width, height });
          }
        }
      }
    }

    return mergeAdjacentBoxes(boxes);
  }

  /*
   * Resolves a PDF outline destination (string or array) to a 1-based page number.
   */
  async function resolveOutlineDestination(pdf, dest) {
    if (!pdf || !dest) return null;
    let explicitDest = dest;
    try {
      if (typeof dest === "string") {
        explicitDest = await pdf.getDestination(dest);
      }
      if (!Array.isArray(explicitDest) || !explicitDest.length) return null;
      const destRef = explicitDest[0];
      if (typeof destRef === "object" && destRef !== null) {
        const pageIndex = await pdf.getPageIndex(destRef);
        return pageIndex + 1;
      }
      if (typeof destRef === "number") {
        return destRef + 1;
      }
    } catch {
      return null;
    }
    return null;
  }

  function calculateThumbnailDimensions(pageWidth, pageHeight, targetWidth = 120) {
    const width = clampNumber(pageWidth, 1, 100000, 595);
    const height = clampNumber(pageHeight, 1, 100000, 842);
    const scale = targetWidth / width;
    return {
      scale,
      width: targetWidth,
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  const api = {
    MAX_PDF_BYTES,
    ZOOM_MIN,
    ZOOM_MAX,
    DEFAULT_SCALE,
    DEFAULT_VIEWER_THEME,
    BACKGROUND_THEMES,
    parsePdfParam,
    parsePageParam,
    viewerUrlFor,
    isPdfMagic,
    buildViewerFilter,
    canvasSizeForViewport,
    calculateThumbnailDimensions,
    resolveViewerTheme,
    isFileUrl,
    isViewerUrl,
    fileNameOf,
    formatViewerTitle,
    buildRenderOrder,
    mergeLineRects,
    buildHighlightAnnotation,
    createAnnotationHistory,
    multiplyMatrix,
    transformPoint,
    mergeAdjacentBoxes,
    extractImageBoxes,
    resolveOutlineDestination,
  };

  globalThis.PDFDarkModeViewer = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  /* ---------------------------------------------------------- DOM boot */

  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (!document.getElementById || window.__pdfDarkModeViewerBooted) return;
  // Probe environments (tests) stub getElementById without real elements.
  if (!document.getElementById("pages")) return;
  window.__pdfDarkModeViewerBooted = true;

  const core = globalThis.PDFDarkModeCore || null;
  const PRICING_URL = "https://pdf-dark.com/#pricing";
  const FEEDBACK_URL = "https://pdf-dark.com/#contact";

  const shellEl = document.querySelector(".viewer-shell");
  const pagesEl = document.getElementById("pages");
  const pageIndicator = document.getElementById("pageIndicator");
  const zoomLabel = document.getElementById("zoomLabel");
  const statusBar = document.getElementById("statusBar");
  const errorBox = document.getElementById("errorBox");
  const errorText = document.getElementById("errorText");
  const fileAccessHint = document.getElementById("fileAccessHint");
  const openFileAccessBtn = document.getElementById("openFileAccessBtn");
  const docTitle = document.getElementById("docTitle");
  const betaNotice = document.getElementById("betaNotice");
  const betaDismissBtn = document.getElementById("betaDismissBtn");
  const betaPill = document.getElementById("betaPill");
  const betaFeedbackLink = document.getElementById("betaFeedbackLink");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const fitWidthBtn = document.getElementById("fitWidthBtn");
  const highlightBtn = document.getElementById("highlightBtn");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const clearHighlightsBtn = document.getElementById("clearHighlightsBtn");
  const saveBtn = document.getElementById("saveBtn");
  const optionsBtn = document.getElementById("optionsBtn");
  const optionsTier = document.getElementById("optionsTier");
  const darkToggleBtn = document.getElementById("darkToggleBtn");
  const smartImagesBtn = document.getElementById("smartImagesBtn");
  const outlineToggleBtn = document.getElementById("outlineToggleBtn");
  const outlineSidebar = document.getElementById("outlineSidebar");
  const closeOutlineBtn = document.getElementById("closeOutlineBtn");
  const tabThumbnailsBtn = document.getElementById("tabThumbnailsBtn");
  const tabOutlineBtn = document.getElementById("tabOutlineBtn");
  const thumbnailView = document.getElementById("thumbnailView");
  const thumbnailList = document.getElementById("thumbnailList");
  const outlineView = document.getElementById("outlineView");
  const outlineList = document.getElementById("outlineList");
  const outlineEmpty = document.getElementById("outlineEmpty");
  const modeSelect = document.getElementById("modeSelect");
  const strengthSlider = document.getElementById("strengthSlider");
  const contrastSlider = document.getElementById("contrastSlider");
  const themeSwatches = document.getElementById("themeSwatches");
  const proNote = document.getElementById("proNote");
  const proLink = document.getElementById("proLink");
  const floatingProBtn = document.getElementById("floatingProBtn");

  let pdfjsLibRef = null;

  const state = {
    pdf: null,
    pageCount: 0,
    visiblePage: 1,
    scale: DEFAULT_SCALE,
    optionsOpen: true,
    betaMinimized: false,
    darkEnabled: true,
    smartImages: true,
    outlineOpen: false,
    outline: null,
    activeSidebarTab: "thumbnails",
    renderedThumbnails: new Set(),
    highlightMode: false,
    nextAnnotationId: 1,
    annotations: new Map(),
    history: createAnnotationHistory(),
    mode: "dark",
    strength: 255,
    contrast: 100,
    themeId: DEFAULT_VIEWER_THEME,
    isPro: false,
    filter: "",
    rendering: false,
    renderQueued: false,
    pdfUrl: parsePdfParam(window.location.search),
    initialPage: parsePageParam(
      typeof window !== "undefined" ? (window.location.hash || window.location.search) : ""
    ),
  };

  boot();

  function boot() {
    wireControls();
    const fileName = fileNameOf(state.pdfUrl);
    if (docTitle) docTitle.textContent = fileName;
    if (typeof document !== "undefined") {
      document.title = formatViewerTitle(fileName, document.title);
    }
    if (openFileAccessBtn) {
      openFileAccessBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: extensionDetailsUrl() });
      });
    }
    if (proLink) proLink.href = PRICING_URL;
    if (betaFeedbackLink) betaFeedbackLink.href = FEEDBACK_URL;
    if (betaDismissBtn) {
      betaDismissBtn.addEventListener("click", () => {
        // Session-only: every load (including reload) starts expanded.
        state.betaMinimized = true;
        applyBetaNotice();
      });
    }
    if (betaPill) {
      betaPill.addEventListener("click", () => {
        state.betaMinimized = false;
        applyBetaNotice();
      });
    }
    if (floatingProBtn) {
      floatingProBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: PRICING_URL });
      });
    }
    if (!state.pdfUrl) {
      fail("No PDF selected. Open this page from a PDF tab via “Open in full dark”.", false);
      return;
    }
    loadAndRender();
  }

  function setOptionsOpen(open) {
    state.optionsOpen = open;
    if (optionsTier) optionsTier.classList.toggle("hidden", !open);
    if (optionsBtn) {
      optionsBtn.setAttribute("aria-expanded", String(open));
      optionsBtn.textContent = open ? "Appearance ▴" : "Appearance ▾";
      optionsBtn.title = open ? "Hide appearance options" : "Show appearance options";
    }
  }

  // Briefly relabels a control to its Pro-gated state, then restores it.
  // Used where the gated control (e.g. collapsing Appearance) otherwise
  // fails silently for free users.
  function flashProOnly(button, label) {
    if (!button) return;
    const original = button.textContent;
    button.textContent = label;
    setTimeout(() => {
      if (button.textContent === label) button.textContent = original;
    }, 1600);
  }

  function extensionDetailsUrl() {
    if (core?.extensionDetailsUrl) return core.extensionDetailsUrl(chrome.runtime.id);
    return "chrome://extensions/";
  }

  function wireControls() {
    if (prevPageBtn) prevPageBtn.addEventListener("click", () => scrollToPage(state.visiblePage - 1));
    if (nextPageBtn) nextPageBtn.addEventListener("click", () => scrollToPage(state.visiblePage + 1));
    if (zoomInBtn) zoomInBtn.addEventListener("click", () => stepZoom(1.2));
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => stepZoom(1 / 1.2));
    if (fitWidthBtn) fitWidthBtn.addEventListener("click", fitWidth);
    if (highlightBtn) {
      highlightBtn.addEventListener("click", () => {
        state.highlightMode = !state.highlightMode;
        highlightBtn.setAttribute("aria-pressed", String(state.highlightMode));
        highlightBtn.classList.toggle("active", state.highlightMode);
        setStatus(state.highlightMode ? "Highlight mode on: select text to highlight" : "");
      });
    }
    if (undoBtn) undoBtn.addEventListener("click", () => undo());
    if (redoBtn) redoBtn.addEventListener("click", () => redo());
    if (clearHighlightsBtn) clearHighlightsBtn.addEventListener("click", () => clearAllHighlights());
    if (saveBtn) {
      saveBtn.addEventListener("click", saveDocument);
    }
    if (optionsBtn && optionsTier) {
      optionsBtn.addEventListener("click", () => {
        if (state.optionsOpen && !state.isPro) {
          // Collapsing the options is a Pro privilege; opening is free.
          // The proNote is already visible to free users, so the refusal
          // must say so on the button itself, briefly.
          flashProOnly(optionsBtn, "🔒 Pro to hide");
          return;
        }
        setOptionsOpen(!state.optionsOpen);
      });
    }
    if (darkToggleBtn) {
      darkToggleBtn.addEventListener("click", () => {
        state.darkEnabled = !state.darkEnabled;
        try {
          if (typeof sessionStorage !== "undefined" && sessionStorage?.setItem) {
            sessionStorage.setItem("__pdm_viewer_dark", String(state.darkEnabled));
          }
        } catch {
          /* ignore */
        }
        applyFilter();
        syncChrome();
        syncControls();
      });
    }
    if (smartImagesBtn) {
      smartImagesBtn.addEventListener("click", () => {
        state.smartImages = !state.smartImages;
        persistSyncValue("smartImages", state.smartImages);
        syncControls();
        applyFigureLayerVisibility();
      });
    }
    if (outlineToggleBtn) {
      outlineToggleBtn.addEventListener("click", () => {
        setOutlineOpen(!state.outlineOpen);
      });
    }
    if (closeOutlineBtn) {
      closeOutlineBtn.addEventListener("click", () => {
        setOutlineOpen(false);
      });
    }
    if (tabThumbnailsBtn) {
      tabThumbnailsBtn.addEventListener("click", () => {
        switchSidebarTab("thumbnails");
      });
    }
    if (tabOutlineBtn) {
      tabOutlineBtn.addEventListener("click", () => {
        switchSidebarTab("outline");
      });
    }
    if (modeSelect) {
      modeSelect.addEventListener("change", () => {
        state.mode = enforceAllowedMode(modeSelect.value);
        modeSelect.value = state.mode;
        persistSyncValue("mode", state.mode);
        refreshFilter();
      });
    }
    if (strengthSlider) {
      strengthSlider.addEventListener("input", () => {
        state.strength = clampNumber(strengthSlider.value, 200, 255, 255);
        refreshFilter();
      });
      strengthSlider.addEventListener("change", () => {
        persistSyncValue("strength", state.strength);
      });
    }
    if (contrastSlider) {
      contrastSlider.addEventListener("input", () => {
        state.contrast = clampNumber(contrastSlider.value, 50, 130, 100);
        refreshFilter();
      });
      contrastSlider.addEventListener("change", () => {
        persistSyncValue("contrast", state.contrast);
      });
    }
    if (themeSwatches) buildSwatches();
    if (pagesEl) {
      let spyTimer = null;
      pagesEl.addEventListener("scroll", () => {
        if (spyTimer) return;
        spyTimer = setTimeout(() => {
          spyTimer = null;
          updateVisiblePage();
        }, 120);
      });
      pagesEl.addEventListener("mouseup", () => {
        if (state.highlightMode) {
          highlightSelection();
        }
      });
      pagesEl.addEventListener("click", (event) => {
        const target = event.target;
        if (target && target.classList && target.classList.contains("highlight-annotation")) {
          const annotId = target.dataset.annotationId;
          if (annotId) {
            event.stopPropagation();
            deleteHighlight(annotId);
          }
        }
      });
      window.addEventListener("keydown", (event) => {
        const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (mod && !event.altKey) {
          const key = event.key ? event.key.toLowerCase() : "";
          if (key === "z") {
            if (event.shiftKey) {
              event.preventDefault();
              redo();
            } else {
              event.preventDefault();
              undo();
            }
          } else if (key === "y" && !isMac) {
            event.preventDefault();
            redo();
          }
        }
      });
      // Trackpad pinch fires wheel + ctrlKey: zoom the document instead of
      // scrolling. Debounced so a single gesture re-renders once.
      let pinchTimer = null;
      pagesEl.addEventListener(
        "wheel",
        (event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          state.scale = clampNumber(
            state.scale * Math.exp(-event.deltaY * 0.01),
            ZOOM_MIN,
            ZOOM_MAX,
            DEFAULT_SCALE
          );
          syncChrome();
          if (pinchTimer) clearTimeout(pinchTimer);
          pinchTimer = setTimeout(() => {
            pinchTimer = null;
            renderAllPages();
          }, 160);
        },
        { passive: false }
      );
    }
    if (chrome.storage?.onChanged?.addListener) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "sync") return;
        if (changes.billing) refreshEntitlement();
        if (changes.active) {
          state.darkEnabled = changes.active.newValue !== false;
          try {
            if (typeof sessionStorage !== "undefined" && sessionStorage?.setItem) {
              sessionStorage.setItem("__pdm_viewer_dark", String(state.darkEnabled));
            }
          } catch {
            /* ignore */
          }
          applyFilter();
          syncChrome();
          syncControls();
        }
        if (changes.mode) {
          state.mode = enforceAllowedMode(changes.mode.newValue);
          refreshFilter();
          syncControls();
        }
        if (changes.strength) {
          state.strength = clampNumber(changes.strength.newValue, 200, 255, 255);
          refreshFilter();
          syncControls();
        }
        if (changes.contrast) {
          state.contrast = clampNumber(changes.contrast.newValue, 50, 130, 100);
          refreshFilter();
          syncControls();
        }
        if (changes.viewerTheme) {
          state.themeId = resolveViewerTheme(changes.viewerTheme.newValue, state.isPro).id;
          applyTheme();
          syncControls();
        }
        if (changes.smartImages !== undefined) {
          state.smartImages = changes.smartImages.newValue !== false;
          syncControls();
          applyFigureLayerVisibility();
        }
      });
    }
  }

  async function loadAndRender() {
    setStatus("Loading PDF…");
    hideError();
    try {
      const response = await fetch(state.pdfUrl);
      if (!response.ok) {
        throw new Error(`Could not fetch the PDF (HTTP ${response.status}).`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_PDF_BYTES) {
        throw new Error("This PDF is too large for the viewer. Open the original instead.");
      }
      if (!isPdfMagic(bytes)) {
        throw new Error("This URL did not return a PDF document.");
      }
      const pdfjs = await import(chrome.runtime.getURL("vendor/pdfjs/pdf.min.mjs"));
      pdfjsLibRef = pdfjs;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
      state.pdf = await pdfjs.getDocument({
        data: bytes,
        wasmUrl: chrome.runtime.getURL("vendor/pdfjs/wasm/"),
        verbosity: pdfjs.VerbosityLevel ? pdfjs.VerbosityLevel.ERRORS : 0,
      }).promise;
      state.pageCount = state.pdf.numPages;
      state.visiblePage = 1;
      persistViewerSession();
      await refreshSettings();
      initThumbnails();
      await loadOutline();
      if (state.outlineOpen) {
        setOutlineOpen(true);
      }
      await renderAllPages();
      persistViewerSession();
    } catch (error) {
      fail(describeError(error), isFileUrl(state.pdfUrl));
    }
  }

  async function refreshSettings() {
    try {
      const stored = await getSyncState([
        "active",
        "strength",
        "contrast",
        "mode",
        "billing",
        "viewerTheme",
        "smartImages",
      ]);
      let savedDark = null;
      try {
        if (typeof sessionStorage !== "undefined" && sessionStorage?.getItem) {
          savedDark = sessionStorage.getItem("__pdm_viewer_dark");
        }
      } catch {
        /* ignore */
      }
      if (savedDark !== null) {
        state.darkEnabled = savedDark === "true";
      } else if (stored.active !== undefined) {
        state.darkEnabled = stored.active !== false;
      }
      if (stored.smartImages !== undefined) {
        state.smartImages = stored.smartImages !== false;
      } else {
        state.smartImages = true;
      }
      try {
        if (typeof sessionStorage !== "undefined" && sessionStorage?.getItem) {
          const userClosed = sessionStorage.getItem("__pdm_viewer_toc_closed");
          if (userClosed === "false") {
            state.outlineOpen = true;
          } else if (userClosed === "true") {
            state.outlineOpen = false;
          }
        }
      } catch {
        /* ignore */
      }
      state.isPro = core ? !!core.getEntitlement(stored.billing).isPro : false;
      state.mode = enforceAllowedMode(stored.mode);
      state.strength = clampNumber(stored.strength, 200, 255, 255);
      state.contrast = clampNumber(stored.contrast, 50, 130, 100);
      state.themeId = resolveViewerTheme(stored.viewerTheme, state.isPro).id;
      state.filter = baseFilter();
      renderGating();
      applyTheme();
      applyBetaNotice();
      syncControls();
    } catch {
      state.filter = buildViewerFilter({ darkEnabled: state.darkEnabled });
    }
  }

  async function refreshEntitlement() {
    try {
      const { billing } = await getSyncState(["billing"]);
      state.isPro = core ? !!core.getEntitlement(billing).isPro : false;
      state.mode = enforceAllowedMode(state.mode);
      state.themeId = resolveViewerTheme(state.themeId, state.isPro).id;
      renderGating();
      applyTheme();
      syncControls();
      refreshFilter();
      renderAllPages();
    } catch {
      /* keep current entitlement */
    }
  }

  function enforceAllowedMode(mode) {
    if (!state.isPro && mode !== "dark") return "dark";
    return mode || "dark";
  }

  function baseFilter() {
    return buildViewerFilter({
      mode: state.mode,
      isPro: state.isPro,
      strength: state.strength,
      contrast: state.contrast,
      darkEnabled: state.darkEnabled,
    });
  }

  function refreshFilter() {
    state.filter = baseFilter();
    applyFilter();
  }

  function renderGating() {
    const locked = !state.isPro;
    if (modeSelect) {
      Array.from(modeSelect.options).forEach((option) => {
        option.disabled = option.value !== "dark" && locked;
      });
    }
    if (floatingProBtn) floatingProBtn.classList.toggle("hidden", !locked);
    if (themeSwatches) {
      Array.from(themeSwatches.children).forEach((button) => {
        const theme = BACKGROUND_THEMES.find((entry) => entry.id === button.dataset.theme);
        button.disabled = !!theme?.isPro && locked;
      });
    }
    if (proNote) proNote.classList.toggle("hidden", !locked);
  }

  function buildSwatches() {
    themeSwatches.innerHTML = "";
    BACKGROUND_THEMES.forEach((theme) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-swatch";
      button.dataset.theme = theme.id;
      button.title = theme.name + (theme.isPro ? " (Pro)" : "");
      button.setAttribute("aria-label", "Background theme: " + theme.name);
      button.style.background = theme.bg;
      button.setAttribute("aria-pressed", String(theme.id === state.themeId));
      button.disabled = theme.isPro && !state.isPro;
      if (theme.isPro) {
        const lock = document.createElement("span");
        lock.className = "lock";
        lock.textContent = "♛";
        button.appendChild(lock);
      }
      button.addEventListener("click", () => {
        if (theme.isPro && !state.isPro) {
          if (proNote) proNote.classList.remove("hidden");
          return;
        }
        state.themeId = theme.id;
        persistSyncValue("viewerTheme", theme.id);
        applyTheme();
        syncControls();
      });
      themeSwatches.appendChild(button);
    });
  }

  function applyTheme() {
    const theme = resolveViewerTheme(state.themeId, state.isPro);
    if (shellEl) {
      shellEl.style.setProperty("--viewer-bg", theme.bg);
      shellEl.style.setProperty("--viewer-chrome", theme.chrome);
    }
  }

  function applyBetaNotice() {
    if (betaNotice) betaNotice.classList.toggle("hidden", state.betaMinimized);
    if (betaPill) betaPill.classList.toggle("hidden", !state.betaMinimized);
  }

  function syncControls() {
    setOptionsOpen(state.optionsOpen);
    setOutlineOpen(state.outlineOpen);
    switchSidebarTab(state.activeSidebarTab || "thumbnails");
    if (smartImagesBtn) {
      smartImagesBtn.setAttribute("aria-pressed", String(state.smartImages));
      smartImagesBtn.textContent = state.smartImages ? "Images: Preserved" : "Images: Inverted";
    }
    if (modeSelect) modeSelect.value = state.mode;
    if (strengthSlider) strengthSlider.value = String(state.strength);
    if (contrastSlider) contrastSlider.value = String(state.contrast);
    if (darkToggleBtn) {
      darkToggleBtn.setAttribute("aria-pressed", String(state.darkEnabled));
      darkToggleBtn.textContent = state.darkEnabled ? "Dark: On" : "Dark: Off";
    }
    if (themeSwatches) {
      Array.from(themeSwatches.children).forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.theme === state.themeId));
      });
    }
  }

  function switchSidebarTab(tabName) {
    state.activeSidebarTab = tabName;
    const isThumbnails = tabName === "thumbnails";
    if (tabThumbnailsBtn) {
      tabThumbnailsBtn.classList.toggle("active", isThumbnails);
      tabThumbnailsBtn.setAttribute("aria-selected", String(isThumbnails));
    }
    if (tabOutlineBtn) {
      tabOutlineBtn.classList.toggle("active", !isThumbnails);
      tabOutlineBtn.setAttribute("aria-selected", String(!isThumbnails));
    }
    if (thumbnailView) {
      thumbnailView.classList.toggle("hidden", !isThumbnails);
    }
    if (outlineView) {
      outlineView.classList.toggle("hidden", isThumbnails);
    }
    if (isThumbnails) {
      scrollActiveThumbnailIntoView();
    }
  }

  function scrollActiveThumbnailIntoView() {
    if (!thumbnailList) return;
    const activeCard = thumbnailList.querySelector(".thumbnail-card.active");
    if (activeCard && typeof activeCard.scrollIntoView === "function") {
      activeCard.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  function syncActiveThumbnail(pageNum) {
    if (!thumbnailList) return;
    const cards = thumbnailList.querySelectorAll(".thumbnail-card");
    cards.forEach((card) => {
      const p = Number(card.dataset.page);
      card.classList.toggle("active", p === pageNum);
    });
  }

  let thumbnailObserver = null;

  function initThumbnails() {
    if (!thumbnailList) return;
    thumbnailList.innerHTML = "";
    state.renderedThumbnails.clear();

    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      thumbnailObserver = null;
    }

    if (!state.pdf || state.pageCount < 1) return;

    if (typeof IntersectionObserver !== "undefined") {
      thumbnailObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const card = entry.target;
              const pageNum = Number(card.dataset.page);
              if (pageNum && !state.renderedThumbnails.has(pageNum)) {
                state.renderedThumbnails.add(pageNum);
                renderThumbnail(pageNum, card);
              }
            }
          });
        },
        {
          root: thumbnailView || outlineSidebar,
          rootMargin: "200px 0px",
        }
      );
    }

    const fragment = document.createDocumentFragment();
    for (let p = 1; p <= state.pageCount; p += 1) {
      const card = document.createElement("div");
      card.className = "thumbnail-card" + (p === state.visiblePage ? " active" : "");
      card.dataset.page = String(p);

      const preview = document.createElement("div");
      preview.className = "thumbnail-preview";

      const canvas = document.createElement("canvas");
      canvas.className = "thumbnail-canvas";
      canvas.width = 120;
      canvas.height = 170;
      if (state.darkEnabled) {
        canvas.style.filter = state.filter || baseFilter();
      }
      preview.appendChild(canvas);
      card.appendChild(preview);

      const num = document.createElement("div");
      num.className = "thumbnail-num";
      num.textContent = String(p);
      card.appendChild(num);

      card.addEventListener("click", () => {
        scrollToPage(p);
        syncActiveThumbnail(p);
      });

      fragment.appendChild(card);
      if (thumbnailObserver) {
        thumbnailObserver.observe(card);
      } else {
        renderThumbnail(p, card);
      }
    }
    thumbnailList.appendChild(fragment);
  }

  async function renderThumbnail(pageNum, card) {
    if (!state.pdf || !card) return;
    const canvas = card.querySelector("canvas.thumbnail-canvas");
    if (!canvas) return;
    try {
      const page = await state.pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const dims = calculateThumbnailDimensions(baseViewport.width, baseViewport.height, 120);
      const dpr = Math.min(typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1, 2);
      const viewport = page.getViewport({ scale: dims.scale });

      canvas.width = Math.round(dims.width * dpr);
      canvas.height = Math.round(dims.height * dpr);
      canvas.style.width = `${dims.width}px`;
      canvas.style.height = `${dims.height}px`;

      const ctx = canvas.getContext("2d");
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      await page.render({
        canvasContext: ctx,
        viewport,
        transform,
      }).promise;

      canvas.style.filter = state.darkEnabled ? (state.filter || baseFilter()) : "";
    } catch {
      /* ignore thumbnail render failure */
    }
  }

  function setOutlineOpen(open) {
    state.outlineOpen = Boolean(open);
    if (outlineSidebar) outlineSidebar.classList.toggle("hidden", !open);
    if (outlineToggleBtn) {
      outlineToggleBtn.setAttribute("aria-expanded", String(open));
      outlineToggleBtn.classList.toggle("active", open);
    }
    if (open) {
      syncActiveThumbnail(state.visiblePage);
      if (state.activeSidebarTab === "thumbnails") {
        setTimeout(scrollActiveThumbnailIntoView, 50);
      }
    }
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage?.setItem) {
        sessionStorage.setItem("__pdm_viewer_toc_closed", String(!open));
      }
    } catch {
      /* ignore */
    }
  }

  async function loadOutline() {
    if (!state.pdf || typeof state.pdf.getOutline !== "function") return;
    try {
      const outline = await state.pdf.getOutline();
      state.outline = outline;
      const hasOutline = Array.isArray(outline) && outline.length > 0;
      renderOutline(outline);
      if (tabOutlineBtn) {
        tabOutlineBtn.title = hasOutline
          ? "Table of contents"
          : "No table of contents in this PDF";
      }
      if (outlineToggleBtn) {
        outlineToggleBtn.title = "Toggle navigation panel (Thumbnails & Table of Contents)";
        outlineToggleBtn.disabled = false;
      }
      if (hasOutline) {
        let userClosed = false;
        try {
          userClosed = sessionStorage?.getItem("__pdm_viewer_toc_closed") === "true";
        } catch {
          /* ignore */
        }
        if (!userClosed) {
          switchSidebarTab("outline");
          setOutlineOpen(true);
        }
      } else {
        switchSidebarTab("thumbnails");
      }
    } catch {
      state.outline = null;
      renderOutline(null);
      switchSidebarTab("thumbnails");
    }
  }

  function renderOutline(items) {
    if (!outlineList) return;
    outlineList.innerHTML = "";
    const hasItems = Array.isArray(items) && items.length > 0;
    if (outlineEmpty) outlineEmpty.classList.toggle("hidden", hasItems);
    if (outlineList) outlineList.classList.toggle("hidden", !hasItems);
    if (!hasItems) return;

    const fragment = document.createDocumentFragment();
    buildOutlineTreeNodes(items, fragment);
    outlineList.appendChild(fragment);
  }

  function buildOutlineTreeNodes(items, container) {
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      const itemEl = document.createElement("div");
      itemEl.className = "outline-item";
      itemEl.setAttribute("role", "treeitem");

      const rowEl = document.createElement("div");
      rowEl.className = "outline-row";

      const hasChildren = Array.isArray(item.items) && item.items.length > 0;
      let toggleBtn = null;
      if (hasChildren) {
        toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "outline-toggle";
        toggleBtn.textContent = "▼";
        toggleBtn.title = "Collapse section";
        toggleBtn.setAttribute("aria-label", "Toggle sub-items");
        rowEl.appendChild(toggleBtn);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "outline-spacer";
        rowEl.appendChild(spacer);
      }

      const labelBtn = document.createElement("button");
      labelBtn.type = "button";
      labelBtn.className = "outline-label";
      labelBtn.textContent = (item.title || "Untitled").trim();
      labelBtn.title = labelBtn.textContent;
      if (item.bold) labelBtn.style.fontWeight = "bold";
      if (item.italic) labelBtn.style.fontStyle = "italic";
      rowEl.appendChild(labelBtn);

      itemEl.appendChild(rowEl);

      let childrenEl = null;
      if (hasChildren) {
        childrenEl = document.createElement("div");
        childrenEl.className = "outline-children";
        childrenEl.setAttribute("role", "group");
        buildOutlineTreeNodes(item.items, childrenEl);
        itemEl.appendChild(childrenEl);

        toggleBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const collapsed = childrenEl.classList.toggle("hidden");
          toggleBtn.textContent = collapsed ? "▶" : "▼";
          toggleBtn.title = collapsed ? "Expand section" : "Collapse section";
        });
      }

      const handleNav = async () => {
        if (item.url) {
          window.open(item.url, "_blank", "noopener,noreferrer");
          return;
        }
        if (item.dest) {
          const pageNum = await resolveOutlineDestination(state.pdf, item.dest);
          if (pageNum) {
            scrollToPage(pageNum);
            if (outlineList) {
              outlineList.querySelectorAll(".outline-row.active").forEach((r) => r.classList.remove("active"));
              rowEl.classList.add("active");
            }
          }
        }
      };

      rowEl.addEventListener("click", handleNav);

      container.appendChild(itemEl);
    });
  }

  async function renderPageFigures(page, pageNum, viewport, dpr) {
    const container = pagesEl.querySelector(`.page-container[data-page="${pageNum}"]`);
    const figureLayer = container?.querySelector(".figure-layer");
    const canvas = container?.querySelector("canvas.page");
    if (!container || !figureLayer || !canvas) return;

    figureLayer.innerHTML = "";
    try {
      const opList = await page.getOperatorList();
      const boxes = extractImageBoxes(opList, viewport, pdfjsLibRef?.OPS);
      if (!boxes.length) return;

      boxes.forEach((box) => {
        const patchCanvas = document.createElement("canvas");
        patchCanvas.className = "figure-patch";
        patchCanvas.style.left = `${box.left}px`;
        patchCanvas.style.top = `${box.top}px`;
        patchCanvas.style.width = `${box.width}px`;
        patchCanvas.style.height = `${box.height}px`;

        const sx = Math.floor(box.left * dpr);
        const sy = Math.floor(box.top * dpr);
        const sw = Math.ceil(box.width * dpr);
        const sh = Math.ceil(box.height * dpr);

        patchCanvas.width = sw;
        patchCanvas.height = sh;

        const pctx = patchCanvas.getContext("2d");
        if (pctx) {
          pctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        }
        figureLayer.appendChild(patchCanvas);
      });
      figureLayer.classList.toggle("hidden", !state.smartImages || !state.darkEnabled);
    } catch {
      /* ignore figure extraction error */
    }
  }

  function applyFigureLayerVisibility() {
    const show = state.smartImages && state.darkEnabled;
    if (!pagesEl) return;
    pagesEl.querySelectorAll(".figure-layer").forEach((layer) => {
      layer.classList.toggle("hidden", !show);
    });
  }

  /* Renders every page into a vertical stack, like the native viewer. */
  async function renderAllPages() {
    if (!state.pdf || state.rendering) {
      state.renderQueued = true;
      return;
    }
    state.rendering = true;
    // Hold the reading position across re-renders: clearing the pages
    // collapses scroll height and drops the reader to the top, so the
    // viewport-center point is recorded as a fraction and mapped back onto
    // the new height afterwards. Skipped on first load (empty stack), which
    // must start at the top.
    const hadPages = pagesEl && pagesEl.children.length > 0;
    const prevScrollHeight = hadPages ? pagesEl.scrollHeight : 0;
    const prevCenter =
      prevScrollHeight > 0
        ? (pagesEl.scrollTop + pagesEl.clientHeight / 2) / prevScrollHeight
        : 0;

    const targetPage =
      state.initialPage > 1 && state.initialPage <= state.pageCount
        ? state.initialPage
        : state.visiblePage || 1;

    try {
      clearPages();
      const samplePageNum = clampNumber(targetPage, 1, state.pageCount, 1);
      const samplePage = await state.pdf.getPage(samplePageNum);
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const sampleViewport = samplePage.getViewport({ scale: state.scale });
      const baseSizing = canvasSizeForViewport(sampleViewport, dpr);

      // Create placeholder elements upfront for all pages so the
      // scroll container immediately reflects the full document height.
      for (let pageNum = 1; pageNum <= state.pageCount; pageNum += 1) {
        const container = document.createElement("div");
        container.className = "page-container";
        container.dataset.page = String(pageNum);
        container.style.width = baseSizing.styleWidth;
        container.style.height = baseSizing.styleHeight;
        container.style.setProperty("--total-scale-factor", String(state.scale));
        container.style.setProperty("--scale-round-x", "1px");
        container.style.setProperty("--scale-round-y", "1px");

        const canvas = document.createElement("canvas");
        canvas.className = "page";
        canvas.dataset.page = String(pageNum);
        canvas.width = baseSizing.width;
        canvas.height = baseSizing.height;
        canvas.style.width = baseSizing.styleWidth;
        canvas.style.height = baseSizing.styleHeight;
        canvas.style.filter = state.filter || baseFilter();
        container.appendChild(canvas);

        const figureLayer = document.createElement("div");
        figureLayer.className = "figure-layer";
        figureLayer.dataset.page = String(pageNum);
        if (!state.smartImages || !state.darkEnabled) {
          figureLayer.classList.add("hidden");
        }
        container.appendChild(figureLayer);

        const textLayer = document.createElement("div");
        textLayer.className = "textLayer text-layer";
        textLayer.dataset.page = String(pageNum);
        textLayer.style.setProperty("--total-scale-factor", String(state.scale));
        textLayer.style.setProperty("--scale-round-x", "1px");
        textLayer.style.setProperty("--scale-round-y", "1px");
        container.appendChild(textLayer);

        const annotLayer = document.createElement("div");
        annotLayer.className = "annotation-layer";
        annotLayer.dataset.page = String(pageNum);
        container.appendChild(annotLayer);

        pagesEl.appendChild(container);
      }

      // Immediately jump to the requested page or restore scroll position,
      // without waiting for pages to render.
      if (state.initialPage > 1 && state.initialPage <= state.pageCount) {
        scrollToPage(state.initialPage);
        state.initialPage = 0;
      } else if (hadPages && pagesEl.scrollHeight > 0 && prevScrollHeight > 0) {
        pagesEl.scrollTop = prevCenter * pagesEl.scrollHeight - pagesEl.clientHeight / 2;
      }
      updateVisiblePage();
      syncChrome();

      // Render pages radiating outward from the visible page.
      const renderOrder = buildRenderOrder(state.visiblePage, state.pageCount);
      let renderedCount = 0;
      for (const pageNum of renderOrder) {
        if (state.renderQueued) break;
        renderedCount += 1;
        setStatus(`Rendering page ${renderedCount} of ${state.pageCount}…`);
        const page = pageNum === samplePageNum ? samplePage : await state.pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });
        const sizing = canvasSizeForViewport(viewport, dpr);
        const container = pagesEl.querySelector(`.page-container[data-page="${pageNum}"]`);
        const canvas = container ? container.querySelector("canvas.page") : pagesEl.querySelector(`canvas.page[data-page="${pageNum}"]`);
        if (container && canvas) {
          container.style.width = sizing.styleWidth;
          container.style.height = sizing.styleHeight;
          if (canvas.width !== sizing.width || canvas.height !== sizing.height) {
            canvas.width = sizing.width;
            canvas.height = sizing.height;
            canvas.style.width = sizing.styleWidth;
            canvas.style.height = sizing.styleHeight;
          }
          await page.render({
            canvasContext: canvas.getContext("2d"),
            viewport,
            transform: sizing.transform,
          }).promise;
          canvas.style.filter = state.filter || baseFilter();

          await renderPageFigures(page, pageNum, viewport, dpr);

          try {
            const annotations = await page.getAnnotations();
            renderExistingAnnotations(pageNum, annotations, viewport);
          } catch {
            /* ignore */
          }
        }
      }
      applyFilter();
      updateVisiblePage();
      syncChrome();
      setupTextLayerObserver();
      setStatus("");
    } catch (error) {
      fail("Could not render this document: " + describeError(error), false);
    } finally {
      state.rendering = false;
      if (state.renderQueued) {
        state.renderQueued = false;
        renderAllPages();
      }
    }
  }

  let textLayerObserver = null;
  const mountedTextLayers = new Set();

  function setupTextLayerObserver() {
    if (textLayerObserver) textLayerObserver.disconnect();
    mountedTextLayers.clear();
    if (typeof IntersectionObserver === "undefined") {
      mountTextLayer(state.visiblePage);
      return;
    }
    textLayerObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const container = entry.target;
          const pageNum = Number(container.dataset.page);
          if (!pageNum) return;
          if (entry.isIntersecting) {
            mountTextLayer(pageNum);
          } else {
            unmountTextLayer(pageNum);
          }
        });
      },
      { root: pagesEl, rootMargin: "400px 0px" }
    );

    const containers = pagesEl.querySelectorAll(".page-container");
    containers.forEach((c) => textLayerObserver.observe(c));
  }

  async function mountTextLayer(pageNum) {
    if (mountedTextLayers.has(pageNum) || !state.pdf) return;
    const container = pagesEl.querySelector(`.page-container[data-page="${pageNum}"]`);
    const textLayerEl = container?.querySelector(".textLayer, .text-layer");
    if (!container || !textLayerEl) return;

    mountedTextLayers.add(pageNum);
    try {
      const page = await state.pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: state.scale });
      textLayerEl.textContent = "";
      textLayerEl.style.setProperty("--total-scale-factor", String(state.scale));
      textLayerEl.style.setProperty("--scale-round-x", "1px");
      textLayerEl.style.setProperty("--scale-round-y", "1px");
      if (pdfjsLibRef?.TextLayer) {
        const textLayer = new pdfjsLibRef.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerEl,
          viewport,
        });
        await textLayer.render();
      }
    } catch {
      mountedTextLayers.delete(pageNum);
    }
  }

  function unmountTextLayer(pageNum) {
    if (!mountedTextLayers.has(pageNum)) return;
    mountedTextLayers.delete(pageNum);
    const container = pagesEl.querySelector(`.page-container[data-page="${pageNum}"]`);
    const textLayerEl = container?.querySelector(".textLayer, .text-layer");
    if (textLayerEl) {
      textLayerEl.textContent = "";
    }
  }

  function renderExistingAnnotations(pageNum, annotations, viewport) {
    const container = pagesEl.querySelector(`.page-container[data-page="${pageNum}"]`);
    const annotLayer = container?.querySelector(".annotation-layer");
    if (!annotLayer) return;

    if (Array.isArray(annotations) && annotations.length) {
      annotations.forEach((annot) => {
        if (annot.subtype === "Highlight") {
          const quads = annot.quadPoints;
          if (Array.isArray(quads) && quads.length >= 8) {
            for (let i = 0; i < quads.length; i += 8) {
              const [vx1, vy1] = viewport.convertToViewportPoint(quads[i], quads[i + 1]);
              const [vx2, vy2] = viewport.convertToViewportPoint(quads[i + 6], quads[i + 7]);
              const left = Math.min(vx1, vx2);
              const top = Math.min(vy1, vy2);
              const width = Math.abs(vx2 - vx1);
              const height = Math.abs(vy2 - vy1);
              if (width > 0 && height > 0) {
                const el = document.createElement("div");
                el.className = "highlight-annotation";
                el.style.left = `${left}px`;
                el.style.top = `${top}px`;
                el.style.width = `${width}px`;
                el.style.height = `${height}px`;
                annotLayer.appendChild(el);
              }
            }
          }
        }
      });
    }

    state.annotations.forEach((item) => {
      if (item.pageNum === pageNum) {
        renderHighlightInDom(pageNum, item.annotId, item.annot.quadPoints, viewport);
      }
    });
  }

  function renderHighlightInDom(pageNum, annotId, quadPoints, viewport) {
    const container = pagesEl.querySelector(`.page-container[data-page="${pageNum}"]`);
    const annotLayer = container?.querySelector(".annotation-layer");
    if (!container || !annotLayer || !Array.isArray(quadPoints) || quadPoints.length < 8) return;

    for (let i = 0; i < quadPoints.length; i += 8) {
      const [vx1, vy1] = viewport.convertToViewportPoint(quadPoints[i], quadPoints[i + 1]);
      const [vx2, vy2] = viewport.convertToViewportPoint(quadPoints[i + 6], quadPoints[i + 7]);
      const left = Math.min(vx1, vx2);
      const top = Math.min(vy1, vy2);
      const width = Math.abs(vx2 - vx1);
      const height = Math.abs(vy2 - vy1);
      if (width > 0 && height > 0) {
        const el = document.createElement("div");
        el.className = "highlight-annotation";
        el.dataset.annotationId = annotId;
        el.title = "Click to remove highlight";
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        annotLayer.appendChild(el);
      }
    }
  }

  function syncAnnotationButtons() {
    if (undoBtn) undoBtn.disabled = !state.history.canUndo;
    if (redoBtn) redoBtn.disabled = !state.history.canRedo;
    if (clearHighlightsBtn) clearHighlightsBtn.disabled = !state.annotations.size;
  }

  function deleteHighlight(annotId) {
    const record = state.annotations.get(annotId);
    if (!record) return false;
    if (state.pdf?.annotationStorage) {
      state.pdf.annotationStorage.remove(annotId);
    }
    pagesEl.querySelectorAll(`[data-annotation-id="${annotId}"]`).forEach((el) => el.remove());
    state.annotations.delete(annotId);
    state.history.recordDelete(record);
    syncAnnotationButtons();
    setStatus("Removed highlight");
    setTimeout(() => setStatus(""), 1500);
    return true;
  }

  function clearAllHighlights() {
    if (!state.annotations.size) return false;
    const items = Array.from(state.annotations.values());
    items.forEach((item) => {
      if (state.pdf?.annotationStorage) {
        state.pdf.annotationStorage.remove(item.annotId);
      }
      pagesEl.querySelectorAll(`[data-annotation-id="${item.annotId}"]`).forEach((el) => el.remove());
      state.annotations.delete(item.annotId);
    });
    state.history.recordClear(items);
    syncAnnotationButtons();
    setStatus("Cleared all highlights");
    setTimeout(() => setStatus(""), 1500);
    return true;
  }

  async function undo() {
    const action = state.history.popUndo();
    if (!action) return false;
    if (action.type === "add") {
      if (state.pdf?.annotationStorage) {
        state.pdf.annotationStorage.remove(action.annotId);
      }
      pagesEl.querySelectorAll(`[data-annotation-id="${action.annotId}"]`).forEach((el) => el.remove());
      state.annotations.delete(action.annotId);
      state.history.pushRedo(action);
      syncAnnotationButtons();
      setStatus("Undo highlight");
      setTimeout(() => setStatus(""), 1200);
      return true;
    }
    if (action.type === "delete") {
      if (state.pdf?.annotationStorage) {
        state.pdf.annotationStorage.setValue(action.annotId, action.annot);
      }
      state.annotations.set(action.annotId, action);
      if (state.pdf) {
        const page = await state.pdf.getPage(action.pageNum);
        const viewport = page.getViewport({ scale: state.scale });
        renderHighlightInDom(action.pageNum, action.annotId, action.annot.quadPoints, viewport);
      }
      state.history.pushRedo(action);
      syncAnnotationButtons();
      setStatus("Restored highlight");
      setTimeout(() => setStatus(""), 1200);
      return true;
    }
    if (action.type === "clearAll") {
      for (const item of action.items) {
        if (state.pdf?.annotationStorage) {
          state.pdf.annotationStorage.setValue(item.annotId, item.annot);
        }
        state.annotations.set(item.annotId, item);
        if (state.pdf) {
          const page = await state.pdf.getPage(item.pageNum);
          const viewport = page.getViewport({ scale: state.scale });
          renderHighlightInDom(item.pageNum, item.annotId, item.annot.quadPoints, viewport);
        }
      }
      state.history.pushRedo(action);
      syncAnnotationButtons();
      setStatus("Restored all highlights");
      setTimeout(() => setStatus(""), 1200);
      return true;
    }
    return false;
  }

  async function redo() {
    const action = state.history.popRedo();
    if (!action) return false;
    if (action.type === "add") {
      if (state.pdf?.annotationStorage) {
        state.pdf.annotationStorage.setValue(action.annotId, action.annot);
      }
      state.annotations.set(action.annotId, action);
      if (state.pdf) {
        const page = await state.pdf.getPage(action.pageNum);
        const viewport = page.getViewport({ scale: state.scale });
        renderHighlightInDom(action.pageNum, action.annotId, action.annot.quadPoints, viewport);
      }
      state.history.pushUndo(action);
      syncAnnotationButtons();
      setStatus("Redo highlight");
      setTimeout(() => setStatus(""), 1200);
      return true;
    }
    if (action.type === "delete") {
      if (state.pdf?.annotationStorage) {
        state.pdf.annotationStorage.remove(action.annotId);
      }
      pagesEl.querySelectorAll(`[data-annotation-id="${action.annotId}"]`).forEach((el) => el.remove());
      state.annotations.delete(action.annotId);
      state.history.pushUndo(action);
      syncAnnotationButtons();
      setStatus("Removed highlight");
      setTimeout(() => setStatus(""), 1200);
      return true;
    }
    if (action.type === "clearAll") {
      action.items.forEach((item) => {
        if (state.pdf?.annotationStorage) {
          state.pdf.annotationStorage.remove(item.annotId);
        }
        pagesEl.querySelectorAll(`[data-annotation-id="${item.annotId}"]`).forEach((el) => el.remove());
        state.annotations.delete(item.annotId);
      });
      state.history.pushUndo(action);
      syncAnnotationButtons();
      setStatus("Cleared all highlights");
      setTimeout(() => setStatus(""), 1200);
      return true;
    }
    return false;
  }

  async function highlightSelection() {
    if (typeof window === "undefined") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);

    let node = range.commonAncestorContainer;
    while (node && (!node.classList || !node.classList.contains("page-container"))) {
      node = node.parentElement;
    }
    if (!node) return;

    const pageNum = Number(node.dataset.page);
    if (!pageNum || !state.pdf) return;

    const page = await state.pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.scale });
    const pageRect = node.getBoundingClientRect();
    const rawRects = Array.from(range.getClientRects());
    if (!rawRects.length) return;
    const rects = mergeLineRects(rawRects);
    if (!rects.length) return;

    const annot = buildHighlightAnnotation(rects, pageRect, viewport, pageNum - 1);
    if (!annot) return;

    const annotId = "pdfjs_internal_editor_" + (state.nextAnnotationId++);
    if (state.pdf.annotationStorage) {
      state.pdf.annotationStorage.setValue(annotId, annot);
    }
    const record = { annotId, annot, pageNum };
    state.annotations.set(annotId, record);
    state.history.recordAdd(record);

    renderHighlightInDom(pageNum, annotId, annot.quadPoints, viewport);
    syncAnnotationButtons();

    selection.removeAllRanges();
    setStatus("Highlighted text");
    setTimeout(() => setStatus(""), 1500);
  }

  async function saveDocument() {
    if (!state.pdf) return;
    setStatus("Saving PDF…");
    try {
      const bytes =
        state.pdf.annotationStorage?.size > 0
          ? await state.pdf.saveDocument()
          : await state.pdf.getData();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const originalName = fileNameOf(state.pdfUrl) || "document.pdf";
      const downloadName = originalName.endsWith(".pdf") ? originalName : `${originalName}.pdf`;

      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      setStatus("Saved PDF!");
      setTimeout(() => setStatus(""), 2000);
    } catch (error) {
      fail("Could not save this document: " + describeError(error), false);
    }
  }

  function clearPages() {
    if (textLayerObserver) {
      textLayerObserver.disconnect();
    }
    mountedTextLayers.clear();
    while (pagesEl.firstChild) pagesEl.removeChild(pagesEl.firstChild);
  }

  function pageCanvases() {
    return Array.from(pagesEl.querySelectorAll("canvas.page"));
  }

  function applyFilter() {
    const filter = state.darkEnabled ? state.filter || baseFilter() : "";
    pageCanvases().forEach((canvas) => {
      canvas.style.filter = filter;
    });
    if (thumbnailList) {
      thumbnailList.querySelectorAll("canvas.thumbnail-canvas").forEach((canvas) => {
        canvas.style.filter = filter;
      });
    }
    if (shellEl) {
      shellEl.classList.toggle("viewer-light", !state.darkEnabled);
    }
    if (darkToggleBtn) {
      darkToggleBtn.setAttribute("aria-pressed", String(state.darkEnabled));
      darkToggleBtn.textContent = state.darkEnabled ? "Dark: On" : "Dark: Off";
    }
    applyFigureLayerVisibility();
  }

  function syncChrome() {
    if (pageIndicator) pageIndicator.textContent = `${state.visiblePage} / ${state.pageCount}`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round((state.scale / DEFAULT_SCALE) * 100)}%`;
    if (prevPageBtn) prevPageBtn.disabled = state.visiblePage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = state.visiblePage >= state.pageCount;
  }

  /* Which page currently owns the middle of the scroll viewport. */
  function updateVisiblePage() {
    const containers = Array.from(pagesEl.querySelectorAll(".page-container"));
    const targets = containers.length ? containers : pageCanvases();
    if (!targets.length) return;
    const middle = pagesEl.scrollTop + pagesEl.clientHeight / 2;
    let current = 1;
    targets.forEach((target) => {
      if (target.offsetTop <= middle) current = Number(target.dataset.page) || current;
    });
    if (current !== state.visiblePage) {
      state.visiblePage = current;
      syncChrome();
      syncActiveThumbnail(current);
      persistViewerSession();
    }
  }

  function scrollToPage(pageNum) {
    const clamped = clampNumber(pageNum, 1, state.pageCount, state.visiblePage);
    const target =
      pagesEl.querySelector(`.page-container[data-page="${clamped}"]`) ||
      pagesEl.querySelector(`canvas.page[data-page="${clamped}"]`);
    if (target) {
      pagesEl.scrollTop = target.offsetTop - 12;
      state.visiblePage = clamped;
      syncChrome();
      syncActiveThumbnail(clamped);
      persistViewerSession();
    }
  }

  function stepZoom(factor) {
    state.scale = clampNumber(state.scale * factor, ZOOM_MIN, ZOOM_MAX, DEFAULT_SCALE);
    renderAllPages();
  }

  async function fitWidth() {
    if (!state.pdf) return;
    try {
      const page = await state.pdf.getPage(state.visiblePage);
      const base = page.getViewport({ scale: 1 });
      const available = pagesEl.clientWidth - 24;
      state.scale = clampNumber(available / base.width, ZOOM_MIN, ZOOM_MAX, DEFAULT_SCALE);
      renderAllPages();
    } catch {
      /* keep current zoom */
    }
  }

  function setStatus(text) {
    if (statusBar) {
      statusBar.textContent = text || "";
      statusBar.classList.toggle("hidden", !text);
    }
  }

  function fail(message, showFileHint) {
    setStatus("");
    if (errorText) errorText.textContent = message;
    if (errorBox) errorBox.classList.remove("hidden");
    if (fileAccessHint) fileAccessHint.classList.toggle("hidden", !showFileHint);
    clearPages();
  }

  function hideError() {
    if (errorBox) errorBox.classList.add("hidden");
  }

  function describeError(error) {
    const message = (error && error.message) || String(error || "Unknown error.");
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return "Could not load this PDF. It may need sign-in or block cross-origin reads — open the original instead. " + message;
    }
    return message;
  }

  function isContextAlive() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime) return false;
      if ("id" in chrome.runtime) {
        return Boolean(chrome.runtime.id);
      }
      return Boolean(chrome.runtime.getURL || chrome.runtime.sendMessage);
    } catch {
      return false;
    }
  }

  function getSyncState(keys) {
    return new Promise((resolve) => {
      if (!isContextAlive() || !chrome.storage?.sync) {
        resolve({});
        return;
      }
      try {
        chrome.storage.sync.get(keys, (res) => {
          try {
            if (chrome.runtime?.lastError) resolve({});
            else resolve(res || {});
          } catch {
            resolve({});
          }
        });
      } catch {
        resolve({});
      }
    });
  }

  function persistSyncValue(key, value) {
    if (!isContextAlive() || !chrome.storage?.sync) return;
    try {
      chrome.storage.sync.set({ [key]: value }, () => {
        try {
          if (chrome.runtime?.lastError) {
            console.error("PDF Dark Mode: failed to save viewer setting", chrome.runtime.lastError);
          }
        } catch {
          /* ignore */
        }
      });
    } catch (error) {
      /* ignore */
    }
  }

  let persistTimer = null;
  function persistViewerSession() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      if (!isContextAlive() || !state.pdfUrl || !chrome.storage?.local) return;
      try {
        const tab = await new Promise((resolve) => {
          try {
            if (isContextAlive() && chrome.tabs?.getCurrent) {
              chrome.tabs.getCurrent((t) => {
                try {
                  if (chrome.runtime?.lastError) resolve(null);
                  else resolve(t || null);
                } catch {
                  resolve(null);
                }
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
        if (!isContextAlive()) return;
        const tabId = tab?.id ? String(tab.id) : "default";
        chrome.storage.local.get(["activeViewerSessions"], (res) => {
          try {
            if (!isContextAlive()) return;
            const sessions = { ...(res?.activeViewerSessions || {}) };
            sessions[tabId] = {
              tabId: tab?.id,
              pdfUrl: state.pdfUrl,
              page: state.visiblePage || 1,
              windowId: tab?.windowId,
              index: tab?.index,
              active: tab?.active,
              updatedAt: Date.now(),
            };
            chrome.storage.local.set({ activeViewerSessions: sessions });
          } catch {
            /* ignore */
          }
        });
      } catch (_e) {
        /* ignore */
      }
    }, 250);
  }
})();
