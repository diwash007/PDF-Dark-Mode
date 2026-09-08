/*
 * The experimental page-rect detector, on synthetic images so the maths is
 * pinned independently of any real browser.
 *
 * Run: node tests/page-clip.test.js
 */

const assert = require("node:assert/strict");
const core = require("../scripts/core.js");

/** Build an RGBA buffer: dark canvas with an optional light rectangle. */
function makeImage({ width, height, rect, bg = 40, fg = 255 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside =
        rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const v = inside ? fg : bg;
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; void name; };

check("finds a centred page and reports its insets", () => {
  const img = makeImage({ width: 1280, height: 760, rect: { x: 376, y: 60, w: 816, h: 700 } });
  const r = core.detectPageInsets(img.data, img.width, img.height);

  assert.ok(r, "should detect something");
  assert.equal(r.confident, true);
  // Sampling every 4th pixel, so allow a step of slack.
  assert.ok(Math.abs(r.left - 376) <= 4, `left ${r.left}`);
  assert.ok(Math.abs(r.top - 60) <= 4, `top ${r.top}`);
  assert.ok(Math.abs(r.right - (1280 - 376 - 816)) <= 4, `right ${r.right}`);
});

check("a narrow sidebar-like strip does not win over the page", () => {
  // A light scrollbar on the far right must not stretch the detected span,
  // which is exactly the bug the longest-contiguous-run rule fixes.
  const img = makeImage({ width: 1280, height: 760, rect: { x: 376, y: 60, w: 816, h: 700 } });
  for (let y = 0; y < 760; y += 1) {
    for (let x = 1270; x < 1280; x += 1) {
      const i = (y * 1280 + x) * 4;
      img.data[i] = 230; img.data[i + 1] = 230; img.data[i + 2] = 230;
    }
  }
  const r = core.detectPageInsets(img.data, img.width, img.height);
  assert.ok(r.right >= 80, `scrollbar should not extend the page span (right=${r.right})`);
});

check("an all-dark page is reported as not confident", () => {
  const img = makeImage({ width: 800, height: 600, rect: null });
  const r = core.detectPageInsets(img.data, img.width, img.height);
  // Either nothing found at all, or found but flagged unusable.
  assert.ok(!r || r.confident === false, "a dark PDF must fall back");
});

check("a page filling the whole viewport is not confident", () => {
  const img = makeImage({ width: 800, height: 600, rect: { x: 0, y: 0, w: 800, h: 600 } });
  const r = core.detectPageInsets(img.data, img.width, img.height);
  assert.equal(r.confident, false, "nothing to clip means fall back to full overlay");
});

check("a sliver of light is rejected", () => {
  const img = makeImage({ width: 1000, height: 800, rect: { x: 10, y: 10, w: 40, h: 30 } });
  const r = core.detectPageInsets(img.data, img.width, img.height);
  assert.ok(!r || r.confident === false, "too small to be a page");
});

check("handles degenerate input without throwing", () => {
  assert.equal(core.detectPageInsets(null, 10, 10), null);
  assert.equal(core.detectPageInsets(new Uint8ClampedArray(0), 0, 0), null);
});

check("un-inverting is lossless, so measuring through the overlay is exact", () => {
  const img = makeImage({ width: 200, height: 120, rect: { x: 40, y: 20, w: 120, h: 80 } });
  const original = Uint8ClampedArray.from(img.data);

  // difference-with-white is 255 - channel; apply it, then undo it.
  const inverted = Uint8ClampedArray.from(img.data);
  core.uninvertInPlace(inverted);
  const restored = Uint8ClampedArray.from(inverted);
  core.uninvertInPlace(restored);

  assert.deepEqual(Array.from(restored), Array.from(original), "must round-trip exactly");

  // And the insets found through an inverted capture match the direct ones.
  const direct = core.detectPageInsets(original, 200, 120);
  const viaOverlay = core.detectPageInsets(
    core.uninvertInPlace(Uint8ClampedArray.from(inverted)),
    200,
    120
  );
  assert.deepEqual(
    { l: viaOverlay.left, t: viaOverlay.top, r: viaOverlay.right },
    { l: direct.left, t: direct.top, r: direct.right },
    "measuring through the overlay must give the same rectangle"
  );
});

check("the toolbar inset is stable while the page width changes", () => {
  // Measured in Chrome: the toolbar height never moves with zoom or sidebar
  // state, which is what makes the top inset safe to trust between measures.
  const tops = [
    { x: 376, w: 816 },
    { x: 336, w: 896 },
    { x: 184, w: 1000 },
  ].map(({ x, w }) => {
    const img = makeImage({ width: 1280, height: 760, rect: { x, y: 60, w, h: 700 } });
    return core.detectPageInsets(img.data, img.width, img.height).top;
  });

  assert.deepEqual(tops, [tops[0], tops[0], tops[0]], "top inset should not vary with page width");
});

console.log(`page-clip: ${passed} scenarios passed`);
