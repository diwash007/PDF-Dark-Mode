/*
 * URL policy behaviour, including the false-positive regression that made
 * ordinary web pages go dark.
 *
 * Run: node tests/policy.test.js
 */

const assert = require("node:assert/strict");
const core = require("../scripts/core.js");

/** The pre-refactor test, kept so the regression stays documented. */
const LEGACY_PDF_PATTERN = /\.pdf($|[?#&])/i;

const PRO = { isPro: true };
const FREE = { isPro: false };

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
}

/* ---------------------------------------------------------- definite PDFs */

const DEFINITE = [
  "https://arxiv.org/pdf/2411.08442v2.pdf",
  "https://arxiv.org/pdf/2411.08442v2.pdf?download=1",
  "https://example.com/docs/report.pdf#page=3",
  "https://example.com/PAPER.PDF",
  "https://example.com/a%20file.pdf",
  "file:///Users/me/reading/thesis.pdf",
  "chrome-extension://abcdefghijklmnop/index.html?src=https%3A%2F%2Fx.com%2Fa.pdf",
  "https://example.com/viewer.html?file=/docs/a.pdf",
  "https://example.com/web/viewer.html#file=%2Fdocs%2Fa.pdf",
];

DEFINITE.forEach((url) => {
  check(`definite: ${url}`, () => {
    assert.ok(core.isDefinitePdfUrl(url), `should be a definite PDF: ${url}`);
    const policy = core.buildPolicy(url, {}, FREE);
    assert.equal(policy.shouldInject, true, `should inject: ${url}`);
    assert.equal(policy.requiresPdfEmbed, false, `should paint without DOM proof: ${url}`);
  });
});

/* --------------------------------------------------------- the regression */

/*
 * These all matched the old whole-URL regex and were darkened outright. They must
 * now require a real PDF embed in the DOM before anything is painted.
 */
const AMBIGUOUS = [
  "https://www.google.com/search?q=annual+report.pdf&hl=en",
  "https://duckduckgo.com/?q=spec.pdf&ia=web",
  "https://example.com/download?file=report.pdf",
  "https://example.com/article?ref=whitepaper.pdf&utm_source=x",
];

AMBIGUOUS.forEach((url) => {
  check(`ambiguous: ${url}`, () => {
    assert.ok(
      LEGACY_PDF_PATTERN.test(url),
      `precondition: the old regex must have matched ${url}`
    );
    assert.equal(
      core.isDefinitePdfUrl(url),
      false,
      `must not be treated as a definite PDF: ${url}`
    );

    const policy = core.buildPolicy(url, {}, FREE);
    assert.equal(policy.shouldInject, true, `still injects to inspect the DOM: ${url}`);
    assert.equal(
      policy.requiresPdfEmbed,
      true,
      `must require a real PDF embed before painting: ${url}`
    );
  });
});

/* ------------------------------------------------------------ never touch */

const IGNORED = [
  "https://example.com/",
  "https://news.ycombinator.com/item?id=123",
  "https://example.com/pdfs/",
  "https://example.com/notapdfx",
  "https://example.com/file.pdfx",
  "https://example.com/about-pdf-tools",
  "",
  "not a url at all",
];

IGNORED.forEach((url) => {
  check(`ignored: ${url || "(empty)"}`, () => {
    const policy = core.buildPolicy(url, {}, FREE);
    assert.equal(policy.shouldInject, false, `should be left alone: ${url}`);
  });
});

/* ------------------------------------------------------------- site rules */

check("pro block rule wins over a definite PDF", () => {
  const rules = { "arxiv.org": "block" };
  assert.equal(
    core.buildPolicy("https://arxiv.org/pdf/1.pdf", rules, PRO).shouldInject,
    false
  );
});

check("block rule is ignored for free users", () => {
  const rules = { "arxiv.org": "block" };
  assert.equal(
    core.buildPolicy("https://arxiv.org/pdf/1.pdf", rules, FREE).shouldInject,
    true
  );
});

check("pro allow rule darkens a non-PDF page without DOM proof", () => {
  const rules = { "docs.internal": "allow" };
  const policy = core.buildPolicy("https://docs.internal/handbook", rules, PRO);
  assert.equal(policy.shouldInject, true);
  assert.equal(policy.requiresPdfEmbed, false);
});

check("allow rule is ignored for free users", () => {
  const rules = { "docs.internal": "allow" };
  assert.equal(
    core.buildPolicy("https://docs.internal/handbook", rules, FREE).shouldInject,
    false
  );
});

check("allow rule beats the embed requirement on an ambiguous URL", () => {
  const rules = { "www.google.com": "allow" };
  const policy = core.buildPolicy(
    "https://www.google.com/search?q=a.pdf&hl=en",
    rules,
    PRO
  );
  assert.equal(policy.shouldInject, true);
  assert.equal(policy.requiresPdfEmbed, false);
});

/* ------------------------------------------------------------ entitlement */

check("entitlement maps plans correctly", () => {
  assert.deepEqual(
    { ...core.getEntitlement({ status: "active", plan: "lifetime" }) }.isPro,
    true
  );
  assert.equal(core.getEntitlement({ status: "active", plan: "lifetime" }).planName, "Lifetime");
  assert.equal(core.getEntitlement({ status: "active", plan: "pro" }).planName, "Pro");
  assert.equal(core.getEntitlement({ status: "inactive", plan: "pro" }).isPro, false);
  assert.equal(core.getEntitlement(null).planName, "Free");
  assert.equal(core.getEntitlement({ status: "active", plan: "free" }).isPro, false);
});

check("hostname extraction is defensive", () => {
  assert.equal(core.getHostnameFromUrl("https://a.example.com/x"), "a.example.com");
  assert.equal(core.getHostnameFromUrl("garbage"), "");
  assert.equal(core.getHostnameFromUrl(undefined), "");
});

console.log(`policy: ${passed} assertions passed`);
