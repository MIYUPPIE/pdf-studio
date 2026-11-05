# services/web: PDF Studio browser UI

Vanilla HTML/CSS/ES modules. No framework, no bundler, no network calls: everything
(icons, fonts fallback stack, engine) is served from this directory, so the app works offline
and files never leave the device.

The UI talks to the C++/MuPDF engine only through the contract in
[`contracts/engine-api.md`](../../contracts/engine-api.md). The engine runs in a Web Worker.

## Structure

```
index.html              app shell (top bar, toolbar, sidebar, viewer, properties, dialogs)
css/app.css             design tokens (light + dark), layout, responsive rules
js/app.js               bootstrap, engine call wrappers (call / mutate / callStructural), zoom, shortcuts, menus
js/engine-client.js     EngineClient: promise RPC over the worker
js/worker.js            Web Worker: loads ../engine/pdfengine.js (or mock), Map<docId, Module.Document>
js/mock-engine.js       in-browser fake engine with the same surface (used with ?mock=1)
js/state.js             shared UI state, tool defaults, tiny event bus
js/geometry.js          pure geometry (rects, quads, selection, zoom, reorder, page ranges); unit tested
js/viewer.js            continuous scroll viewer, lazy HiDPI rendering, per-page overlay layers, form-field inputs
js/thumbnails.js        sidebar thumbnails, multi-select, drag-to-reorder, context menu
js/props.js             properties panel (tool options or selected annotation)
js/search.js            find in document
js/docops.js            merge, extract/split, export image, compress, protect, unlock, metadata, fonts, download
js/dialogs.js           toasts, busy spinner, <dialog> modals, context menu, downloads
js/icons.js             inline SVG icon set
js/tools/*.js           one module per tool family (select, edittext, create, markup, signature, redact, form)
tests/unit/             node --test (pure logic)
tests/e2e/              Playwright against the mock engine
```

### Engine call model

* `app.call(method, args, bytes)`: raw call, shows a spinner for slow ops.
* `app.mutate(method, args, bytes, {page})`: mutating call. Re-renders only `page` and its thumbnail,
  invalidates that page's caches (annotations, fields, text layout), refreshes `info` for undo/redo state.
* Structural methods (`rotatePages`, `deletePages`, `reorderPages`, `insertBlankPage`, `insertDocument`,
  `undo`, `redo`) return `DocInfo`; the page list is rebuilt from it (DOM nodes are reused to avoid flicker).

### Rendering

Pages render at `scale × devicePixelRatio`, capped at 16 MP per page, only when within 800px of the
viewport (IntersectionObserver). Pages render with `widgets: false`; form fields are live HTML inputs in
the overlay. All overlay elements are positioned in page-space points via CSS variables
(`--x --y --w --h` × `--s`), so zooming only updates `--s`.

## Run

```bash
make wasm && make serve        # from the repo root; http://localhost:8765/
# mock engine (no build needed): http://localhost:8765/?mock=1
```

The engine is loaded from `engine/pdfengine.js` + `pdfengine.wasm` (built by `make wasm`, gitignored).
Fallback fonts for non-Latin scripts live in `engine/fonts/`; the worker fetches a font synchronously
the first time the engine asks for it (`pdfeditFetchFont` in `js/worker.js`). The file pickers'
`accept` lists come from the engine's `formats` method at startup.

### Creating PDFs

* **Blank PDF**: `create` with page count and size.
* **Convert files to PDF**: one or many files of any supported type, reorderable, with a page size for
  reflowable inputs. The first file is opened (`open`), the rest are appended with `insertDocument`,
  one undo step per file. Dropping several files on the landing page starts the same flow.

## Tests

```bash
npm install
npx playwright test --project=chromium      # 57 UI tests against the mock engine
npx playwright test --project=real-engine   # 6 tests against the real wasm engine (needs make wasm)
node --test tests/unit/                     # pure logic
```
