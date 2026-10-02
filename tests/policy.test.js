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

/* ------------------------------------------------------- browser tag */

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BRAVE_BRANDS = [{ brand: "Chromium" }, { brand: "Brave" }, { brand: "Not-A.Brand" }];
const EDGE_BRANDS = [{ brand: "Chromium" }, { brand: "Microsoft Edge" }];

check("browser detection prefers client hints, then UA", () => {
  assert.deepEqual(
    core.detectBrowser({ brands: BRAVE_BRANDS, userAgent: CHROME_UA, isBrave: false }),
    { family: "brave", os: "windows", tag: "brave-windows" }
  );
  assert.deepEqual(
    core.detectBrowser({ brands: [], userAgent: CHROME_UA, isBrave: true }).family,
    "brave",
    "isBrave() disambiguates Brave's Chrome-identical UA"
  );
  assert.deepEqual(
    core.detectBrowser({ brands: EDGE_BRANDS, userAgent: CHROME_UA }).tag,
    "edge-windows"
  );
  assert.deepEqual(
    core.detectBrowser({ brands: [], userAgent: CHROME_UA }).tag,
    "chrome-windows"
  );
  assert.deepEqual(
    core.detectBrowser({
      brands: [],
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    }).tag,
    "safari-macos"
  );
  assert.deepEqual(
    core.detectBrowser({
      brands: [],
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    }).tag,
    "firefox-linux"
  );
});

check("browser detection degrades to unknown-unknown, never raw input", () => {
  for (const input of [null, undefined, {}, { brands: "x" }, { userAgent: 42 }]) {
    assert.deepEqual(core.detectBrowser(input), {
      family: "unknown",
      os: "unknown",
      tag: "unknown-unknown",
    });
  }
  assert.equal(core.sanitizeBrowserTag("brave-macos"), "brave-macos");
  assert.equal(core.sanitizeBrowserTag("BRAVE-MACOS"), "brave-macos", "case normalizes");
  for (const hostile of ["", "../../etc", "chrome", "a-b-c", "x".repeat(200), null, undefined, 42]) {
    assert.equal(core.sanitizeBrowserTag(hostile), "", `rejects ${JSON.stringify(hostile)}`);
  }
});

check("extension details URL targets this extension", () => {
  assert.equal(
    core.extensionDetailsUrl("abcdefghijklmnop"),
    "chrome://extensions/?id=abcdefghijklmnop"
  );
  assert.equal(core.extensionDetailsUrl(""), "chrome://extensions/");
  assert.equal(core.extensionDetailsUrl(undefined), "chrome://extensions/");
});

console.log(`policy: ${passed} assertions passed`);
