/*
 * Rendering parity guard.
 *
 * Before this refactor the overlay CSS was written out by hand in three places
 * (scripts/invert.js, popup/popup.js, and the marketing site). This test pins the
 * NEW single implementation against a verbatim copy of the OLD one, so the visual
 * output cannot drift silently.
 *
 * Exactly one difference is expected and asserted explicitly: the old code emitted
 * `width: calc(100vw - ...)` / `height: calc(100vh - ...)` alongside all four
 * insets. That over-constrained the box (width wins, `right` is ignored) and 100vw
 * includes the scrollbar, so the overlay hung past the right edge of the viewport.
 * The four insets alone are correct.
 *
 * Run: node tests/overlay-parity.test.js
 */

const assert = require("node:assert/strict");
const core = require("../scripts/core.js");

/* ------------------------------------------------------------------ *
 * Reference implementation — copied verbatim from scripts/invert.js
 * at commit 7c1dac1 (v2.1.3). Do not "clean up"; its job is to be the
 * historical record of what shipped.
 * ------------------------------------------------------------------ */
function legacyOverlay(state, entitlement) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const strength = clamp(Number(state.strength) || 255, 200, 255);
  const contrast = clamp(Number(state.contrast) || 100, 50, 130);
  const mode = !entitlement.isPro && state.mode !== "dark" ? "dark" : state.mode || "dark";
  const blendStrengthHex = mode === "amoled" ? "ff" : strength.toString(16).padStart(2, "0");
  const contrastValue = mode === "amoled" ? Math.max(contrast, 110) : contrast;
  const brightnessValue = mode === "amoled" ? 78 : 100;
  const area = state.area || { top: 0, right: 0, bottom: 0, left: 0 };

  const dark = `
    position: fixed;
    pointer-events: none;
    top: ${area.top}px;
    left: ${area.left}px;
    right: ${area.right}px;
    bottom: ${area.bottom}px;
    width: calc(100vw - ${area.left}px - ${area.right}px);
    height: calc(100vh - ${area.top}px - ${area.bottom}px);
    background-color: #${blendStrengthHex}ffffff;
    mix-blend-mode: difference;
    z-index: 2147483646;
    filter: contrast(${contrastValue}%) brightness(${brightnessValue}%);
  `;

  const tint =
    mode === "sepia"
      ? `
    position: fixed;
    pointer-events: none;
    top: ${area.top}px;
    left: ${area.left}px;
    right: ${area.right}px;
    bottom: ${area.bottom}px;
    width: calc(100vw - ${area.left}px - ${area.right}px);
    height: calc(100vh - ${area.top}px - ${area.bottom}px);
    background-color: rgba(112, 66, 20, 0.2);
    mix-blend-mode: multiply;
    z-index: 2147483647;
  `
      : null;

  return { dark, tint };
}

/* ------------------------------------------------------------------ */

/** Parse an inline style string into a declaration map, ignoring whitespace. */
function declarations(style) {
  const out = {};
  if (!style) return out;
  style
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((chunk) => {
      const idx = chunk.indexOf(":");
      const prop = chunk.slice(0, idx).trim();
      const value = chunk.slice(idx + 1).trim().replace(/\s+/g, " ");
      out[prop] = value;
    });
  return out;
}

const SIZING = ["width", "height"];
const omitSizing = (map) => {
  const copy = { ...map };
  SIZING.forEach((key) => delete copy[key]);
  return copy;
};

/* ------------------------------------------------------------------ *
 * Matrix
 * ------------------------------------------------------------------ */

const MODES = ["dark", "sepia", "amoled"];
const STRENGTHS = [200, 210, 227, 254, 255, 199, 300, 0, NaN];
const CONTRASTS = [50, 75, 100, 110, 130, 49, 200, 0];
const AREAS = [
  { top: 0, right: 0, bottom: 0, left: 0 },
  { top: 64, right: 0, bottom: 0, left: 0 },
  { top: 0, right: 24, bottom: 0, left: 24 },
  { top: 120, right: 16, bottom: 48, left: 8 },
  { top: 1, right: 2, bottom: 3, left: 4 },
];

let checks = 0;
let sizingSeenInLegacy = 0;

for (const mode of MODES) {
  for (const strength of STRENGTHS) {
    for (const contrast of CONTRASTS) {
      for (const area of AREAS) {
        const label = `mode=${mode} strength=${strength} contrast=${contrast} area=${JSON.stringify(area)}`;

        const legacy = legacyOverlay({ mode, strength, contrast, area }, { isPro: true });
        const next = core.buildOverlayStyles({ mode, strength, contrast, area, isPro: true });

        const legacyDark = declarations(legacy.dark);
        const nextDark = declarations(next.dark);

        if (legacyDark.width) sizingSeenInLegacy += 1;

        assert.deepEqual(
          omitSizing(nextDark),
          omitSizing(legacyDark),
          `dark layer drifted for ${label}`
        );

        // The intentional fix: no over-constraining width/height any more.
        assert.equal(nextDark.width, undefined, `width should be gone for ${label}`);
        assert.equal(nextDark.height, undefined, `height should be gone for ${label}`);

        // Tint presence must match exactly.
        assert.equal(
          !!next.tint,
          !!legacy.tint,
          `sepia tint presence drifted for ${label}`
        );

        if (next.tint) {
          assert.deepEqual(
            omitSizing(declarations(next.tint)),
            omitSizing(declarations(legacy.tint)),
            `tint layer drifted for ${label}`
          );
        }

        checks += 1;
      }
    }
  }
}

assert.ok(sizingSeenInLegacy > 0, "reference implementation should have emitted width/height");

/* ------------------------------------------------------------------ *
 * Free-plan clamping must behave exactly as before
 * ------------------------------------------------------------------ */

for (const mode of MODES) {
  const legacy = legacyOverlay({ mode, strength: 255, contrast: 100 }, { isPro: false });
  const next = core.buildOverlayStyles({ mode, strength: 255, contrast: 100, isPro: false });

  assert.equal(next.tint, null, `free plan must never get the sepia tint (mode=${mode})`);
  assert.deepEqual(
    omitSizing(declarations(next.dark)),
    omitSizing(declarations(legacy.dark)),
    `free-plan clamp drifted for mode=${mode}`
  );
  assert.equal(next.mode, "dark", `free plan must resolve to dark (mode=${mode})`);
}

/* ------------------------------------------------------------------ *
 * Hardening beyond parity (new behaviour, asserted deliberately)
 * ------------------------------------------------------------------ */

// Unknown modes used to pass straight through for Pro users; now they fall back.
assert.equal(
  core.buildOverlayStyles({ mode: "neon", isPro: true }).mode,
  "dark",
  "unknown modes should fall back to dark"
);

// Fractional / hostile area values are normalised rather than interpolated raw.
const messy = core.buildOverlayStyles({
  mode: "dark",
  area: { top: 12.6, right: -5, bottom: "8", left: null },
});
const messyDecls = declarations(messy.dark);
assert.equal(messyDecls.top, "13px", "fractional insets should round");
assert.equal(messyDecls.right, "0px", "negative insets should floor at zero");
assert.equal(messyDecls.bottom, "8px", "numeric strings should be accepted");
assert.equal(messyDecls.left, "0px", "null insets should floor at zero");

// The red-channel quirk is load-bearing: strength lives in the RED byte of an
// #RRGGBBAA colour, so 210 -> #d2ffffff. Pin it so nobody "fixes" it.
assert.equal(
  declarations(core.buildOverlayStyles({ mode: "dark", strength: 210 }).dark)["background-color"],
  "#d2ffffff",
  "strength must map to the red channel of the blend colour"
);
assert.equal(
  declarations(core.buildOverlayStyles({ mode: "amoled", strength: 200 }).dark)["background-color"],
  "#ffffffff",
  "amoled must force a fully opaque blend regardless of strength"
);

console.log(`overlay-parity: ${checks} combinations verified, all matched legacy output`);
