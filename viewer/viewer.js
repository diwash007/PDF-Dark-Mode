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

  const api = {
    MAX_PDF_BYTES,
    ZOOM_MIN,
    ZOOM_MAX,
    DEFAULT_SCALE,
    DEFAULT_VIEWER_THEME,
    BACKGROUND_THEMES,
    parsePdfParam,
    viewerUrlFor,
    isPdfMagic,
    buildViewerFilter,
    canvasSizeForViewport,
    resolveViewerTheme,
    isFileUrl,
    isViewerUrl,
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
  const proBtn = document.getElementById("proBtn");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const fitWidthBtn = document.getElementById("fitWidthBtn");
  const optionsBtn = document.getElementById("optionsBtn");
  const optionsTier = document.getElementById("optionsTier");
  const darkToggleBtn = document.getElementById("darkToggleBtn");
  const modeSelect = document.getElementById("modeSelect");
  const strengthSlider = document.getElementById("strengthSlider");
  const contrastSlider = document.getElementById("contrastSlider");
  const themeSwatches = document.getElementById("themeSwatches");
  const proNote = document.getElementById("proNote");
  const proLink = document.getElementById("proLink");
  const floatingProBtn = document.getElementById("floatingProBtn");

  const state = {
    pdf: null,
    pageCount: 0,
    visiblePage: 1,
    scale: DEFAULT_SCALE,
    optionsOpen: true,
    darkEnabled: true,
    mode: "dark",
    strength: 255,
    contrast: 100,
    themeId: DEFAULT_VIEWER_THEME,
    isPro: false,
    filter: "",
    rendering: false,
    renderQueued: false,
    pdfUrl: parsePdfParam(window.location.search),
  };

  boot();

  function boot() {
    wireControls();
    if (docTitle) docTitle.textContent = fileNameOf(state.pdfUrl);
    if (openFileAccessBtn) {
      openFileAccessBtn.addEventListener("click", () => {
        const url = core ? `chrome://extensions/?id=${chrome.runtime.id}` : "chrome://extensions/";
        chrome.tabs.create({ url });
      });
    }
    if (proBtn) {
      proBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: PRICING_URL });
      });
    }
    if (proLink) proLink.href = PRICING_URL;
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

  function wireControls() {
    if (prevPageBtn) prevPageBtn.addEventListener("click", () => scrollToPage(state.visiblePage - 1));
    if (nextPageBtn) nextPageBtn.addEventListener("click", () => scrollToPage(state.visiblePage + 1));
    if (zoomInBtn) zoomInBtn.addEventListener("click", () => stepZoom(1.2));
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => stepZoom(1 / 1.2));
    if (fitWidthBtn) fitWidthBtn.addEventListener("click", fitWidth);
    if (optionsBtn && optionsTier) {
      optionsBtn.addEventListener("click", () => {
        if (state.optionsOpen && !state.isPro) {
          // Collapsing the options is a Pro privilege; opening is free.
          if (proNote) proNote.classList.remove("hidden");
          return;
        }
        setOptionsOpen(!state.optionsOpen);
      });
    }
    if (darkToggleBtn) {
      darkToggleBtn.addEventListener("click", () => {
        state.darkEnabled = !state.darkEnabled;
        applyFilter();
        syncChrome();
        syncControls();
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
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
      state.pdf = await pdfjs.getDocument({ data: bytes }).promise;
      state.pageCount = state.pdf.numPages;
      state.visiblePage = 1;
      await refreshSettings();
      await renderAllPages();
    } catch (error) {
      fail(describeError(error), isFileUrl(state.pdfUrl));
    }
  }

  async function refreshSettings() {
    try {
      const stored = await getSyncState([
        "strength",
        "contrast",
        "mode",
        "billing",
        "viewerTheme",
      ]);
      state.isPro = core ? !!core.getEntitlement(stored.billing).isPro : false;
      state.mode = enforceAllowedMode(stored.mode);
      state.strength = clampNumber(stored.strength, 200, 255, 255);
      state.contrast = clampNumber(stored.contrast, 50, 130, 100);
      state.themeId = resolveViewerTheme(stored.viewerTheme, state.isPro).id;
      state.filter = baseFilter();
      renderGating();
      applyTheme();
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
    if (proBtn) proBtn.classList.toggle("hidden", !locked);
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

  function syncControls() {
    setOptionsOpen(state.optionsOpen);
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
    try {
      clearPages();
      for (let pageNum = 1; pageNum <= state.pageCount; pageNum += 1) {
        setStatus(`Rendering page ${pageNum} of ${state.pageCount}…`);
        const page = await state.pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });
        const sizing = canvasSizeForViewport(
          viewport,
          (typeof window !== "undefined" && window.devicePixelRatio) || 1
        );
        const canvas = document.createElement("canvas");
        canvas.className = "page";
        canvas.dataset.page = String(pageNum);
        canvas.width = sizing.width;
        canvas.height = sizing.height;
        canvas.style.width = sizing.styleWidth;
        canvas.style.height = sizing.styleHeight;
        pagesEl.appendChild(canvas);
        await page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: sizing.transform,
        }).promise;
        canvas.style.filter = state.filter || baseFilter();
      }
      applyFilter();
      if (hadPages && pagesEl.scrollHeight > 0 && prevScrollHeight > 0) {
        pagesEl.scrollTop = prevCenter * pagesEl.scrollHeight - pagesEl.clientHeight / 2;
      }
      updateVisiblePage();
      syncChrome();
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

  function clearPages() {
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
    if (darkToggleBtn) {
      darkToggleBtn.setAttribute("aria-pressed", String(state.darkEnabled));
      darkToggleBtn.textContent = state.darkEnabled ? "Dark: On" : "Dark: Off";
    }
  }

  function syncChrome() {
    if (pageIndicator) pageIndicator.textContent = `${state.visiblePage} / ${state.pageCount}`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round((state.scale / DEFAULT_SCALE) * 100)}%`;
    if (prevPageBtn) prevPageBtn.disabled = state.visiblePage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = state.visiblePage >= state.pageCount;
  }

  /* Which page currently owns the middle of the scroll viewport. */
  function updateVisiblePage() {
    const canvases = pageCanvases();
    if (!canvases.length) return;
    const middle = pagesEl.scrollTop + pagesEl.clientHeight / 2;
    let current = 1;
    canvases.forEach((canvas) => {
      if (canvas.offsetTop <= middle) current = Number(canvas.dataset.page) || current;
    });
    if (current !== state.visiblePage) {
      state.visiblePage = current;
      syncChrome();
    }
  }

  function scrollToPage(pageNum) {
    const clamped = clampNumber(pageNum, 1, state.pageCount, state.visiblePage);
    const target = pagesEl.querySelector(`canvas.page[data-page="${clamped}"]`);
    if (target) {
      pagesEl.scrollTop = target.offsetTop - 12;
      state.visiblePage = clamped;
      syncChrome();
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

  function getSyncState(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.get(keys, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  function persistSyncValue(key, value) {
    try {
      chrome.storage.sync.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          console.error("PDF Dark Mode: failed to save viewer setting", chrome.runtime.lastError);
        }
      });
    } catch (error) {
      console.error("PDF Dark Mode: failed to save viewer setting", error);
    }
  }
})();
