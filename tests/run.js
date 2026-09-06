#!/usr/bin/env node
/*
 * Runs every test suite. No dependencies, no test framework — `node tests/run.js`.
 *
 * These are dev-only files; they are not loaded by the extension at runtime and
 * can be excluded from the store upload.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const suites = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".test.js"))
  .sort();

let failed = 0;

suites.forEach((suite) => {
  try {
    const output = execFileSync(process.execPath, [path.join(dir, suite)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(`  PASS  ${output.trim()}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL  ${suite}\n`);
    process.stdout.write(`${error.stdout || ""}${error.stderr || ""}\n`);
  }
});

if (failed) {
  console.error(`\n${failed} of ${suites.length} suite(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${suites.length} suites passed.`);
