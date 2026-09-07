/*
 * Truth table for core.shouldPaint — the single place that decides whether the
 * overlay is on screen.
 *
 * The row that matters most is `active: false`. Before this refactor the content
 * script never consulted the global flag, so Ctrl+Shift+1 wrote active:false and
 * then repainted the overlay anyway. The shortcut could not turn dark mode off.
 *
 * Run: node tests/visibility.test.js
 */

const assert = require("node:assert/strict");
const core = require("../scripts/core.js");

const base = {
  shouldInject: true,
  requiresPdfEmbed: false,
  active: true,
  pageEnabled: true,
  isPdf: false,
};

const cases = [
  // [description, overrides, expected]
  ["plain PDF, everything on", {}, true],
  ["not a PDF page", { shouldInject: false }, false],

  // The regression this whole change exists to fix.
  ["global switch off", { active: false }, false],
  ["global switch off on a confirmed PDF", { active: false, requiresPdfEmbed: false }, false],
  ["global switch off even on a real PDF", { active: false, requiresPdfEmbed: true, isPdf: true }, false],

  // Per-page dock toggle.
  ["page toggled off by the dock", { pageEnabled: false }, false],
  ["page toggled back on", { pageEnabled: true }, true],

  // Ambiguous URLs need DOM proof.
  ["ambiguous URL that is not a PDF document", { requiresPdfEmbed: true, isPdf: false }, false],
  ["ambiguous URL that really is a PDF", { requiresPdfEmbed: true, isPdf: true }, true],

  // Precedence: a disabled extension beats everything else.
  [
    "global off wins over page on and a real PDF",
    { active: false, pageEnabled: true, requiresPdfEmbed: true, isPdf: true },
    false,
  ],
  [
    "page off wins over a confirmed PDF",
    { active: true, pageEnabled: false, requiresPdfEmbed: false },
    false,
  ],
];

cases.forEach(([description, overrides, expected]) => {
  const input = { ...base, ...overrides };
  assert.equal(
    core.shouldPaint(input),
    expected,
    `${description} -> expected ${expected}\n  input: ${JSON.stringify(input)}`
  );
});

// Undefined flags must not accidentally hide the overlay: only an explicit
// `false` disables. Storage returns undefined before defaults are written.
assert.equal(
  core.shouldPaint({ shouldInject: true }),
  true,
  "undefined active/pageEnabled should default to visible"
);
assert.equal(core.shouldPaint({}), false, "no injection means no paint");
assert.equal(core.shouldPaint(null), false, "missing input must not throw");

console.log(`visibility: ${cases.length + 3} assertions passed`);
