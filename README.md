![PDF Dark Mode Logo](/images/PDM%20128x128.png)

# PDF Dark Mode

Browser extension that adds customizable dark mode support for PDF files to reduce eye strain while reading.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0).  
See the [LICENSE](./LICENSE) file for details.

## Attribution

This project was originally inspired by and partially derived from:

- DarkPDF by ArshSB  
  https://github.com/ArshSB/DarkPDF

DarkPDF is licensed under GPL-3.0, and this project complies with the terms of that license.

All modifications, additional features, UI changes, entitlement logic, and ongoing maintenance in this repository are independently developed for PDF Dark Mode.

## Background

I had to read a bunch of PDFs at night during exams. Black text on a white background caused significant eye strain, and existing extensions did not provide enough customization for readability and comfort. PDF Dark Mode was built to solve that problem with adjustable reading controls and additional viewing modes.

## Features

### Free Features

- Supports both online and offline PDFs
- Toggle dark mode
- Adjustable darkness strength
- Adjustable contrast
- Core PDF dark reading experience

### Pro Features

- Additional reading modes:
  - Sepia
  - AMOLED
- Per-site allow/block rules
- Per-site overlay area presets
- Lemon Squeezy license key activation and validation
- Future premium productivity and customization features

Pro is a **one-time purchase**. There is no subscription and no renewal, and a
purchased license covers Pro features added in later versions.

## Pro License Validation Policy

- Pro access is activated using a Lemon Squeezy license key.
- License status is validated automatically in the background (no manual validate step in popup).
- Validation is throttled to periodic checks (about every 24 hours), not on every popup open.
- Stale-while-revalidate behavior is used: if a previously active license is stored locally, Pro remains available while background validation runs.
- If Lemon Squeezy reports the license as invalid or inactive (for example after a refund or chargeback), Pro access is removed on the next successful validation.
- Network failures never revoke Pro. Access is only withdrawn when Lemon Squeezy explicitly rejects the key.

## Privacy

PDF Dark Mode does not collect or transmit personal browsing data.

Current analytics functionality is:
- local-only
- stored on-device
- not sent to external servers

The extension makes exactly one network request, and only when you activate or
revalidate a license: `api.lemonsqueezy.com`. There are no analytics endpoints,
no CDNs and no webfonts — everything the UI needs is bundled, so the popup and
the instruction pages work offline and leak nothing to third parties.

## Installation

- Chrome Web Store: https://chromewebstore.google.com/detail/pdf-dark-mode/clabimobhdkbfpkdeloigeneocldkmdc
- Microsoft Edge Add-ons: https://microsoftedge.microsoft.com/addons/detail/pdf-dark-mode/nghkmkbjhpgdibgopgekgjnbocfmnjdo


## Development

No build step and no dependencies — load the folder as an unpacked extension via
`chrome://extensions` with Developer Mode on.

```
node tests/run.js
```

The suites are plain Node, no framework:

| Suite | Guards |
| --- | --- |
| `overlay-parity` | The overlay CSS still matches the pre-refactor output, across 1080 input combinations |
| `visibility` | The truth table for when the overlay is shown, including the global on/off switch |
| `policy` | Which URLs count as PDFs, including the false positives that used to darken search results |
| `popup-smoke` | `popup.js` runs against the real `popup.html` element set, for free and Pro |
| `worker-smoke` | Injection, the keyboard shortcut, cross-tab syncing and first-run defaults |
| `integrity` | Manifest references resolve, scripts parse, no third-party requests, no duplicated overlay code |

### Architecture

`scripts/core.js` is the single source of truth for two decisions: whether a page
should be darkened, and what the overlay looks like. It is loaded by the service
worker (`importScripts`), the content script (injected ahead of `invert.js`) and
the popup (`<script>`).

That logic previously existed as three hand-maintained copies which had already
drifted — the content script recognised Google Drive URLs the worker never
injected on, so the code was unreachable. If you change the rendering maths,
change it in `core.js` and let `overlay-parity` tell you what moved.

## Contributing

Contributions, bug reports, and feature suggestions are welcome.

Please open an issue or submit a pull request if you would like to contribute.

## Commercial Use

Commercial distribution and paid feature offerings are permitted under GPL-3.0, provided that GPL obligations and license terms are respected.

## Updates

- Updates will continue gradually
- Additional accessibility and reading features are planned

## Disclaimer

PDF Dark Mode is an independent project and is not affiliated with or endorsed by the original DarkPDF project or its contributors.