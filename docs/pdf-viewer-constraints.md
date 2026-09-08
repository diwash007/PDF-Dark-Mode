# What Chrome's PDF viewer exposes to an extension

Measured in Chrome 152 with the extension loaded, via the DevTools protocol.
Reproduce with `tests/browser/investigate-pdf-viewer.js` and
`tests/browser/probe-reflow-triggers.js`.

This exists so nobody re-investigates it in six months.

## The viewer is a closed box

The entire top-level document for a PDF is eight elements, four of which are
ours:

```
#document                 contentType: application/pdf
  HTML
    HEAD
      LINK -> chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css
    BODY
      DIV#darkDiv           <- ours
      DIV#pdfDarkModeDock   <- ours
      #document-fragment    <- CLOSED shadow root
        LINK
        IFRAME  (type=application/pdf)
        SLOT
```

- The viewer's iframe lives in a **closed** shadow root on `body`, so
  `body.shadowRoot` is `null` from a content script.
- That iframe is `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`
  — **a different extension**, in its own process. It does not appear in
  `Page.getFrameTree`.
- `chrome.scripting.executeScript({ allFrames: true })` returns **only frameId 0**.
- `document.elementFromPoint(centre)` returns `BODY`. The PDF is not
  hit-testable, so there is no geometry to read.
- `document.body` has **zero height** and no `<embed>`.

### Consequences

**Detecting a PDF.** `embed[type="application/pdf"]` never matches a top-level
PDF. `document.contentType` is the only honest signal. Getting this wrong once
silently disabled dark mode on every `?file=x.pdf` URL — see
`core.isPdfDocument()`.

**Theming only the page.** A CSS `filter` on the root *does* reach the rendered
PDF (verified: white page → black), but a filter on a shadow host applies to its
whole subtree, so the toolbar goes with it. And no colour-only rule can help:
the toolbar's dark grey and the page's black text are the same colour, so any
operation that lightens one lightens the other. **The behaviour has to differ by
region, which means geometry is mandatory** — hence the screenshot-based
approach in `core.detectPageInsets()`.

## Which layout changes are observable

| Action | Page rect moves | Signal we get |
| --- | --- | --- |
| Viewer zoom button | yes, left 376 → 336 | **none** |
| Sidebar toggle | yes, left 336 → 184 | **none** |
| Window resize | yes | `resize`, `ResizeObserver` |
| Browser zoom | yes, top 60 → 92 | none directly; `chrome.tabs.onZoomChange` in the worker |

For the silent two, everything below was checked and none of it changes:
`hashchange`, `popstate`, `location.href`, `location.hash`, `document.title`,
`history.length`, `body.getBoundingClientRect()`, `MutationObserver`,
`ResizeObserver`, and click/wheel/keydown bubbling out of the frame. Input inside
the viewer's frame does not reach the top document at all.

**This is why the experimental page clip ships a manual "Re-align" button.** It
is not laziness; there is no event to hook.

One thing that never moves: the **toolbar inset is constant** — 60 CSS px across
three window sizes, after viewer zoom, after sidebar toggle, after resize, and
92 px at DPR 1.5 (i.e. 60 × 1.5). The top inset is safe to trust between
measurements.

## Costs

- `captureVisibleTab` at 1440×900: **~77 ms** PNG, ~60 ms JPEG q20.
- `detectPageInsets` on the result: **1–3 ms**.

The capture dominates, which is why measurement is event-driven and retried a
couple of times rather than polled. A 2-second poll would burn roughly 3% of a
core per open PDF tab.

PNG is used rather than JPEG because the capture is taken *through* the inverted
overlay, and JPEG artefacts in the near-black regions survive un-inversion.

## Permissions

`captureVisibleTab` requires **`<all_urls>`** or an active `activeTab` grant.
The existing `http://*/*` + `https://*/*` + `file://*/*` host permissions are
**not** accepted — verified:

```
Error: Either the '<all_urls>' or 'activeTab' permission is required.
```

`<all_urls>` is therefore declared under **`optional_host_permissions`** and
requested at runtime when the user turns the feature on. Putting it in
`host_permissions` would disable the extension for every existing user until
they re-approved it, for a feature almost nobody enables.

## Timing

Chrome's PDF viewer paints asynchronously and there is no "document is on
screen" event. A measurement taken ~1 s after load can see an empty grey viewer
and find no page at all. The content script therefore retries at 0 / 700 /
1600 ms before settling for the full-viewport overlay.
