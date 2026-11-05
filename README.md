# PDF Studio

A PDF editor that runs entirely in the browser. The editing engine is C++ on top of
[MuPDF](https://mupdf.com) 1.28.6, compiled to WebAssembly. Files are processed on the
user's device and never uploaded, so hosting is a static site.

## What it does

| Area | Features |
|---|---|
| Edit existing text | Click any line and retype it. Only the changed characters are rewritten: the unchanged start of the line is untouched, the rest shifts with its own fonts, sizes, colours and spacing. The original embedded font is reused when it has every glyph you type; otherwise the closest standard font is used, scaled to the original's width. Works on rotated pages, with superscripts, and with Yoruba, Vietnamese, Arabic, CJK and more (fonts load on demand). |
| Add content | Text boxes, images, freehand ink, rectangles, ellipses, lines, arrows, highlight, underline, strike-out, sticky notes, signatures (draw, type or upload). All of it stays movable and editable until you flatten. |
| Forms | Fill text, checkbox, radio, combo and list fields. Create new fields, including signature fields. |
| Redaction | Permanently removes the text, image pixels and vector graphics under the marked area. It doesn't just cover them up. |
| Pages | Reorder (drag), rotate, delete, insert blank, merge files, extract or split, export a page as PNG or JPEG. |
| Create PDF | Blank PDF, or convert and combine files into one PDF: Word (.docx), Excel (.xlsx), PowerPoint (.pptx), HWPX, HTML, Markdown, text, EPUB, MOBI, FB2, XPS, SVG, CBZ, and images (PNG, JPEG, GIF, BMP, TIFF, PSD...). |
| Output | Undo/redo for every action (it still works after saving), compress (image downsampling and font subsetting), password-protect with AES-256 and set permissions, remove a password, edit metadata, flatten annotations and forms. |

## Layout

```
contracts/engine-api.md   the boundary between engine and UI (methods, JSON shapes, coordinates, errors)
services/engine/          C++ engine: src/, wasm/bindings.cpp, tests/ (gate), evals/ (quality), tools/cli.cpp
services/web/             browser UI: vanilla HTML/CSS/ES modules, Web Worker, Playwright e2e
patches/                  local fixes to MuPDF, applied by scripts/fetch_deps.sh
scripts/                  fetch_deps.sh (pinned MuPDF, emsdk, json, doctest), gen_font_map.py
third_party/              fetched sources and builds (gitignored)
```

The UI talks to the engine only through `contracts/engine-api.md`. Either side can be worked on
on its own; the UI has a mock engine (`?mock=1`) that implements the same contract.

## Quick start

```bash
make deps      # MuPDF 1.28.6 (+ patches), Emscripten 6.0.13, nlohmann/json, doctest  (one time, ~10 min)
make mupdf     # build MuPDF natively and for wasm                                    (one time)
make wasm      # C++ engine -> services/web/engine/pdfengine.{js,wasm} + lazy fonts
make serve     # http://localhost:8765
```

## Tests and evals

| Command | What | Time |
|---|---|---|
| `make test` | Engine gate tests (55 cases, deterministic, native) + web unit tests | ~2 s |
| `make test-asan` | Engine gate tests under AddressSanitizer + UBSan | ~10 s |
| `make test-wasm` | The shipped wasm module, driven from Node | ~1 s |
| `make e2e` | 57 browser tests against the mock engine and 6 against the real wasm engine | ~25 s |
| `make eval` | Text-edit fidelity on real-world PDFs, verified with Poppler (independent reader) | ~20 s |

The pre-commit hook (`.githooks/pre-commit`, enabled by `make hooks`) runs `make test`.

### The eval

`services/engine/evals/run_eval.py` edits a word in sampled lines of real documents (LaTeX papers,
IRS forms, Word/LibreOffice exports, tables, rotated pages), saves, and checks with Poppler that:
the new text extracts, the old word is gone, the other lines are untouched, the PDF is valid, and
the rendering outside the edited line is unchanged. Current result: **77/77 edits pass**
(threshold 0.95), median 53 ms per edit, original font reused in 52% of edits (the rest are raw
Type 1 fonts that other readers reject when re-embedded, so they get the metric-scaled standard
font instead). Corpus: `services/engine/evals/fetch_corpus.sh`.

## Deploying

Live site: https://miyuppie.github.io/pdf-studio/ . Every push to `main` runs
`.github/workflows/deploy.yml`, which builds MuPDF and the engine, runs the gate tests and the
wasm smoke test, and publishes `build/site` to GitHub Pages.

To host elsewhere, run `make site` and upload `build/site/` to any static host (Netlify, Cloudflare Pages, S3,
nginx). Requirements:

* `.wasm` served as `application/wasm`; enable gzip or brotli (the 7.5 MB wasm compresses to 3.2 MB).
* `engine/fonts/` must be deployed too (164 fonts, 18 MB total). Each is fetched only when a script needs it.
* No special headers (no SharedArrayBuffer/COOP/COEP needed).

## License

AGPL-3.0, because MuPDF is AGPL. If you deploy this publicly, the complete source of the
deployed site must be available to its users (a public repository satisfies this), or you need a
commercial MuPDF license from Artifex.

## Known limits

* Text written by edits is not shaped: right-to-left and complex scripts (Arabic joining,
  Devanagari conjuncts) are drawn glyph by glyph.
* Legacy `.doc`/`.xls`/`.ppt` and OpenDocument formats cannot be converted.
* Scanned pages are images: editing their "text" needs OCR, which is not included.
