/*
 * PDF Dark Mode — shared core.
 *
 * Loaded in three places, so it must stay dependency-free and side-effect-free:
 *   - the service worker, via importScripts("scripts/core.js")
 *   - the content script, injected as files: ["scripts/core.js", "scripts/invert.js"]
 *   - the popup, via <script src="../scripts/core.js"></script>
 *
 * The content script can be injected repeatedly into the same page, so this file
 * guards against redefinition and never mutates anything on load.
 *
 * Anything that decides WHETHER to darken, or WHAT the overlay looks like, belongs
 * here. It used to live in three hand-maintained copies that had already drifted
 * apart (see tests/overlay-parity.test.js).
 */

(() => {
  if (globalThis.PDFDarkModeCore) {
    return;
  }

  const DARK_LAYER_ID = "darkDiv";
  const TINT_LAYER_ID = "tintDiv";

  const STRENGTH_MIN = 200;
  const STRENGTH_MAX = 255;
  const CONTRAST_MIN = 50;
  const CONTRAST_MAX = 130;

  // AMOLED forces a fully opaque blend and pushes contrast/brightness.
  const AMOLED_MIN_CONTRAST = 110;
  const AMOLED_BRIGHTNESS = 78;

  const SEPIA_TINT = "rgba(112, 66, 20, 0.2)";

  const EMPTY_AREA = { top: 0, right: 0, bottom: 0, left: 0 };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getHostnameFromUrl(url) {
    if (!url) return "";
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  function defaultBilling() {
    return {
      plan: "free",
      status: "inactive",
      source: "free",
      licenseKey: "",
      instanceId: "",
      instanceName: "",
      lastValidatedAt: "",
      lastValidationAttemptAt: "",
      licenseStatus: "not_configured",
      errorMessage: "",
    };
  }

  function getEntitlement(billingState) {
    const billing = { ...defaultBilling(), ...(billingState || {}) };
    const isPro =
      billing.status === "active" &&
      (billing.plan === "pro" || billing.plan === "lifetime");
    const planName = isPro ? (billing.plan === "lifetime" ? "Lifetime" : "Pro") : "Free";
    return { isPro, planName, billing };
  }

  /* ---------------------------------------------------------------- policy */

  function pathnameLooksLikePdf(pathname) {
    if (!pathname) return false;
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      /* keep the raw pathname if it isn't valid percent-encoding */
    }
    return /\.pdf$/i.test(decoded.trim());
  }

  function nestedUrlLooksLikePdf(value, base) {
    if (!value) return false;
    try {
      return pathnameLooksLikePdf(new URL(value, base).pathname);
    } catch {
      return pathnameLooksLikePdf(value.split(/[?#]/)[0]);
    }
  }

  /*
   * A URL we are confident points at an actual PDF document.
   *
   * Deliberately anchored to the END OF THE PATHNAME rather than "does .pdf appear
   * anywhere in the URL". The old test was /\.pdf($|[?#&])/ against the whole URL,
   * which matched things like
   *     https://www.google.com/search?q=annual+report.pdf&hl=en
   * and darkened ordinary web pages that merely mentioned a PDF.
   */
  function isDefinitePdfUrl(url) {
    if (!url) return false;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (pathnameLooksLikePdf(parsed.pathname)) {
      return true;
    }

    // Chrome's own viewer wrapper: chrome-extension://<id>/index.html?src=<pdf url>
    if (parsed.protocol === "chrome-extension:" && /\/index\.html$/i.test(parsed.pathname)) {
      if (nestedUrlLooksLikePdf(parsed.searchParams.get("src"), parsed.origin)) {
        return true;
      }
    }

    /*
     * pdf.js viewers: .../viewer.html?file=<pdf url> or #file=<pdf url>.
     *
     * Gated on the pathname looking like a viewer. A bare ?file=x.pdf is NOT enough —
     * plenty of sites use /download?file=report.pdf for an endpoint that returns an
     * HTML wrapper, and darkening those outright is the bug this whole change exists
     * to kill. Those fall through to the ambiguous path and need DOM proof.
     */
    if (/(^|\/)(web\/)?viewer\.html?$/i.test(parsed.pathname) || /\/pdf\.js\//i.test(parsed.pathname)) {
      if (nestedUrlLooksLikePdf(parsed.searchParams.get("file"), parsed.origin)) {
        return true;
      }

      const hashFile = /[#&]file=([^&]+)/i.exec(parsed.hash || "");
      if (hashFile) {
        let candidate = hashFile[1];
        try {
          candidate = decodeURIComponent(candidate);
        } catch {
          /* use the raw value */
        }
        if (nestedUrlLooksLikePdf(candidate, parsed.origin)) {
          return true;
        }
      }
    }

    return false;
  }

  /*
   * A URL that mentions a PDF but might not be one — typically a dynamic download
   * endpoint (?file=report.pdf) or a search page. We still inject on these, but the
   * content script refuses to paint unless it finds a real PDF embed in the DOM.
   */
  function isAmbiguousPdfUrl(url) {
    if (!url) return false;
    return /\.pdf($|[^a-z0-9])/i.test(url) || /%2Epdf/i.test(url);
  }

  /**
   * The single injection/darkening decision, shared by worker, popup and content script.
   *
   * @returns {{shouldInject: boolean, requiresPdfEmbed: boolean}}
   *   requiresPdfEmbed — inject the script, but only paint if the page really
   *   contains a PDF embed. Keeps dynamic PDF endpoints working without darkening
   *   every page whose URL happens to contain ".pdf".
   */
  function buildPolicy(url, siteRules, entitlement) {
    const deny = { shouldInject: false, requiresPdfEmbed: false };
    if (!url) return deny;

    const isPro = !!(entitlement && entitlement.isPro);
    const hostname = getHostnameFromUrl(url);
    const siteRule = isPro && hostname ? (siteRules || {})[hostname] : "";

    if (siteRule === "block") return deny;
    if (isDefinitePdfUrl(url)) return { shouldInject: true, requiresPdfEmbed: false };
    if (siteRule === "allow") return { shouldInject: true, requiresPdfEmbed: false };
    if (isAmbiguousPdfUrl(url)) return { shouldInject: true, requiresPdfEmbed: true };

    return deny;
  }

  /**
   * Final say on whether the overlay should be on screen right now.
   *
   * Split out as a pure function because the `active` flag used to be checked
   * only at injection time by the tab listener. The content script never looked
   * at it, so the keyboard shortcut wrote active:false and then immediately
   * repainted the overlay — the shortcut could not turn dark mode off.
   *
   * @param {object} input
   * @param {boolean} input.shouldInject    from buildPolicy
   * @param {boolean} input.requiresPdfEmbed from buildPolicy
   * @param {boolean} input.active          global on/off switch
   * @param {boolean} input.pageEnabled     per-page override from the floating dock
   * @param {boolean} input.hasEmbed        a real PDF embed was found in the DOM
   */
  function shouldPaint(input) {
    const opts = input || {};
    if (!opts.shouldInject) return false;
    if (opts.active === false) return false;
    if (opts.pageEnabled === false) return false;
    if (opts.requiresPdfEmbed && !opts.hasEmbed) return false;
    return true;
  }

  /* --------------------------------------------------------------- overlay */

  function resolveMode(mode, isPro) {
    const requested = mode || "dark";
    if (!isPro && requested !== "dark") return "dark";
    if (requested !== "dark" && requested !== "sepia" && requested !== "amoled") return "dark";
    return requested;
  }

  function normalizeArea(area) {
    const source = area || EMPTY_AREA;
    const toPx = (value) => Math.max(0, Math.round(Number(value) || 0));
    return {
      top: toPx(source.top),
      right: toPx(source.right),
      bottom: toPx(source.bottom),
      left: toPx(source.left),
    };
  }

  /**
   * Build the inline styles for the overlay layers.
   *
   * The four insets fully determine a position:fixed box, so no width/height is
   * emitted. The previous implementation also set width: calc(100vw - ...), which
   * over-constrained the box (width wins, `right` is ignored) AND measured against
   * 100vw — which includes the scrollbar — so the overlay hung past the right edge.
   *
   * @returns {{dark: string, tint: string|null, mode: string, strength: number, contrast: number}}
   */
  function buildOverlayStyles(options) {
    const opts = options || {};
    const mode = resolveMode(opts.mode, opts.isPro !== false);
    const strength = clamp(Number(opts.strength) || STRENGTH_MAX, STRENGTH_MIN, STRENGTH_MAX);
    const contrast = clamp(Number(opts.contrast) || 100, CONTRAST_MIN, CONTRAST_MAX);
    const area = normalizeArea(opts.area);

    const blendStrengthHex =
      mode === "amoled" ? "ff" : strength.toString(16).padStart(2, "0");
    const contrastValue = mode === "amoled" ? Math.max(contrast, AMOLED_MIN_CONTRAST) : contrast;
    const brightnessValue = mode === "amoled" ? AMOLED_BRIGHTNESS : 100;

    const box =
      `position: fixed;` +
      `pointer-events: none;` +
      `top: ${area.top}px;` +
      `left: ${area.left}px;` +
      `right: ${area.right}px;` +
      `bottom: ${area.bottom}px;`;

    const dark =
      box +
      `background-color: #${blendStrengthHex}ffffff;` +
      `mix-blend-mode: difference;` +
      `z-index: 2147483646;` +
      `filter: contrast(${contrastValue}%) brightness(${brightnessValue}%);`;

    const tint =
      mode === "sepia"
        ? box +
          `background-color: ${SEPIA_TINT};` +
          `mix-blend-mode: multiply;` +
          `z-index: 2147483647;`
        : null;

    return { dark, tint, mode, strength, contrast };
  }

  /* ------------------------------------------------------------- DOM apply */

  function removeOverlay(doc) {
    const target = doc || globalThis.document;
    if (!target) return;
    [DARK_LAYER_ID, TINT_LAYER_ID].forEach((id) => {
      const node = target.getElementById(id);
      if (node) node.remove();
    });
  }

  function paintOverlay(styles, doc) {
    const target = doc || globalThis.document;
    if (!target || !target.body || !styles) return;

    removeOverlay(target);

    const darkLayer = target.createElement("div");
    darkLayer.id = DARK_LAYER_ID;
    darkLayer.setAttribute("style", styles.dark);
    target.body.appendChild(darkLayer);

    if (styles.tint) {
      const tintLayer = target.createElement("div");
      tintLayer.id = TINT_LAYER_ID;
      tintLayer.setAttribute("style", styles.tint);
      target.body.appendChild(tintLayer);
    }
  }

  /** Chrome renders built-in PDFs into an <embed type="application/pdf">. */
  function hasPdfEmbed(doc) {
    const target = doc || globalThis.document;
    if (!target || !target.querySelector) return false;
    return !!target.querySelector(
      'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"]'
    );
  }

  const api = {
    DARK_LAYER_ID,
    TINT_LAYER_ID,
    STRENGTH_MIN,
    STRENGTH_MAX,
    CONTRAST_MIN,
    CONTRAST_MAX,
    clamp,
    getHostnameFromUrl,
    defaultBilling,
    getEntitlement,
    isDefinitePdfUrl,
    isAmbiguousPdfUrl,
    buildPolicy,
    shouldPaint,
    resolveMode,
    normalizeArea,
    buildOverlayStyles,
    paintOverlay,
    removeOverlay,
    hasPdfEmbed,
  };

  globalThis.PDFDarkModeCore = api;

  // Node (tests) — harmless everywhere else.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
