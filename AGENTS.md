# Agent instructions — PDF Dark Mode

## Definition of done: verify nothing breaks

The user holds us to this literally: after ANY change, prove nothing regressed
before reporting done. Follow this checklist in order.

### 1. Run the full test suite

System `node` (Homebrew) is broken in this environment (`llhttp` dylib
mismatch). Always run tests with an nvm Node, e.g.:

```
~/.nvm/versions/node/v22.21.0/bin/node tests/run.js
```

All 7 suites must pass: content-smoke, integrity, overlay-parity, policy,
popup-smoke, visibility, worker-smoke. The `integrity` suite now includes a
guard that global `.hidden` is the last `display` rule in `popup/popup.css` —
do not weaken or skip it.

### 2. Real-browser check before any publish

Stubbed suites once passed while the extension was visibly broken. Before
publishing, run:

```
CHROME_BIN=/path/to/chrome node tests/browser/extension.test.js
```

### 3. CSS cascade discipline (`popup/popup.css`)

- Same-specificity rules resolve by source order. A component class like
  `.file-access-banner { display: flex }` beats an earlier global
  `.hidden { display: none }`.
- Therefore: global `.hidden` MUST stay the last `display` rule in the file
  (see the comment above it). Never "dedup" a component-specific
  `.x.hidden` rule without proving the component sets no `display` of its own.
- After any CSS edit, audit every element JS hides via `classList.toggle/add("hidden")`
  (`popup.js`, `instruction/index.js`) against its CSS `display`.

### 4. Review the diff before finishing

- `git status --short`, `git diff --staged` — every hunk must be intentional.
- `manifest.json` permissions must stay `["storage", "activeTab", "tabs",
  "scripting", "alarms"]` unless a store review note is explicitly requested.
- Network hosts stay `api.lemonsqueezy.com` + `pdf-dark.com` (guarded by
  `integrity.test.js`). No new CDNs, webfonts, or endpoints.
- Never delete dev tooling (e.g. debug billing section) as "dead code"
  without asking — hidden-behind-a-flag is not dead.

### 5. Report honestly

State what was verified (suites, browser test, diff review). If a check was
skipped, say so and why. Never claim "nothing breaks" without the evidence above.
