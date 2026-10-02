# Vendored dependencies (full-dark viewer)

No CDN at runtime for library code: these files ship inside the extension
and are loaded from `chrome-extension://` (CSP `script-src 'self'`).
The viewer fetches PDF bytes and renders locally — documents never leave
the device.

| File | Package | Version | sha256 |
| --- | --- | --- | --- |
| `pdfjs/pdf.min.mjs` | pdfjs-dist | 6.3.289 | f80490490320511e5df18c580b9edd6b5db8058dceebaf6f161992e0a964b9e2 |
| `pdfjs/pdf.worker.min.mjs` | pdfjs-dist | 6.3.289 | 8ab0e5e30031b4a06ecfddd5ae9562f0227f830ee7ec9ed1a968b134243d2386 |

Licenses: Apache-2.0 (see `LICENSE.pdfjs`) — compatible with this repo's GPL-3.0.

## Re-vendoring

```sh
cd "$(mktemp -d)"
npm pack pdfjs-dist@<version>
tar -xzf pdfjs-dist-*.tgz -C pdf
cp pdf/package/build/pdf.min.mjs pdf/package/build/pdf.worker.min.mjs <repo>/vendor/pdfjs/
```

Then update this table (verify with `shasum -a 256`).

Load `viewer/viewer.html?pdf=<encoded-pdf-url>` via
`chrome-extension://<id>/viewer/viewer.html?pdf=...` and re-run
`node tests/run.js` before committing.
