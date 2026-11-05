# Engine API contract (v1)

The boundary between `services/engine` (C++ / MuPDF, compiled to WebAssembly) and
`services/web` (browser UI). Both sides import nothing else from each other.
Breaking changes bump `ENGINE_API_VERSION` (returned by `version`) and both sides
update together.

## Transport

The wasm module is built as an ES module factory:

```js
import createPdfEngine from "./engine/pdfengine.js";   // emitted by the engine build
const Module = await createPdfEngine();
const doc = new Module.Document();
const resJson = doc.call("open", JSON.stringify({ name: "a.pdf" }), uint8ArrayOrNull);
const res = JSON.parse(resJson);         // { ok: true, result: ... } | { ok: false, error: { code, message } }
const bytes = doc.takeBytes();           // Uint8Array copy of the binary output of the LAST call, or null
doc.delete();                             // free C++ object when done
```

* `call(method: string, argsJson: string, bytes: Uint8Array | null) -> string` never throws.
* Every result is `{"ok":true,"result":<value>}` or `{"ok":false,"error":{"code":"...","message":"..."}}`.
* Error codes: `bad_args`, `no_document`, `needs_password`, `bad_password`, `bad_page`,
  `not_found`, `unsupported`, `mupdf` (engine error, message has details).
* Calls that produce binary output (`render`, `save`, `extractPages`, `exportPageImage`) put it in `takeBytes()`.
* The web app runs the module inside a Web Worker. One `Document` per open file.

## Coordinate system

All geometry is in **page space**: PDF points (1/72 in), origin at the **top-left of the
displayed page**, y grows down, page rotation already applied. Rendering at `scale`
gives pixel = point × scale. Rects are `[x0, y0, x1, y1]`. Points are `[x, y]`.
Quads are `[ulx, uly, urx, ury, llx, lly, lrx, lry]`.
Colors are `[r, g, b]` with components 0..1. Page indices are 0-based.

## Methods

| method | args | result | bytes in / out |
|---|---|---|---|
| `version` | `{}` | `{ api: 1, mupdf: "1.28.6" }` | |
| `open` | `{ name: string, password?: string, pageSize?: "A4"\|"Letter"\|"Legal"\|"A3"\|"A5"\|[w,h], fontSize?: 11 }` | `DocInfo` | in: file bytes. Anything in `formats` is accepted; non-PDF input is converted to PDF. `pageSize`/`fontSize` lay out reflowable inputs (DOCX, XLSX, PPTX, HWPX, HTML, Markdown, TXT, EPUB, FB2, MOBI); default A4 / 11pt |
| `create` | `{ pages?: 1, pageSize?: "A4" }` | `DocInfo` | new blank PDF |
| `formats` | `{}` | `{ extensions: string[] }` input types this build converts (e.g. pdf, docx, xlsx, pptx, html, md, txt, epub, xps, svg, png, jpg, tiff, cbz) | |
| `authenticate` | `{ password }` | `DocInfo` (error `bad_password` on failure) | |
| `info` | `{}` | `DocInfo` | |
| `render` | `{ page, scale, annots?: bool=true, widgets?: bool=true }` | `{ width, height }` | out: RGBA8 premultiplied=false, row-major |
| `textLayout` | `{ page }` | `TextLayout` | |
| `search` | `{ page, needle, max?: 500 }` | `{ hits: Quad[][] }` (one entry per hit, each hit 1+ quads). Searches everything visible: content, annotations and form-field values | |
| `replaceText` | `ReplaceTextReq` | `{ ok: true, font: string, usedOriginalFont: bool }` | |
| `addText` | `{ page, x, y, text, size, color, font?: FontName, lineHeight?: 1.2 }` | `{}` (writes into page content, baseline of first line at y) | |
| `addImage` | `{ page, rect }` | `{}` (writes into page content) | in: PNG/JPEG bytes |
| `listAnnotations` | `{ page }` | `{ annots: Annot[] }` | |
| `addAnnotation` | `{ page, ...AnnotSpec }` | `{ id }` | in: image bytes when `type=="Stamp"` with image |
| `updateAnnotation` | `{ page, id, ...partial AnnotSpec }` | `{}` Geometry given explicitly (`ink`/`points`/`quads`) is applied as-is. If only `rect` is given for a geometry annotation, its geometry is mapped from the old bounds onto the new rect (move/resize). Image stamps keep their image when moved/resized | |
| `deleteAnnotation` | `{ page, id }` | `{}` | |
| `listFields` | `{ page }` | `{ fields: Field[] }` | |
| `setFieldValue` | `{ page, id, value: string \| bool }` | `{}` | |
| `addField` | `{ page, type: "text"\|"checkbox"\|"combo"\|"list"\|"radio"\|"signature", rect, name?, options?: string[], value?, multiline?: bool, fontSize?: 0 }` | `{ id, name }` | |
| `deleteField` | `{ page, id }` | `{}` | |
| `redact` | `{ page, rects: Rect[], fill?: Color=[0,0,0], images?: bool=true, graphics?: bool=true }` | `{}` permanently removes content | |
| `rotatePages` | `{ pages: int[], degrees: 90\|180\|270\|-90 }` | `DocInfo` | |
| `deletePages` | `{ pages: int[] }` | `DocInfo` | |
| `reorderPages` | `{ order: int[] }` (permutation, new index i shows old page order[i]; may duplicate/omit) | `DocInfo` | |
| `insertBlankPage` | `{ at, width?: 595, height?: 842 }` | `DocInfo` | |
| `insertDocument` | `{ at, name?, password?, pageSize?, fontSize? }` | `DocInfo` | in: other file bytes, any `formats` type (`name` carries the extension). Use it to combine many files into one PDF |
| `extractPages` | `{ pages: int[] }` | `{}` | out: new PDF bytes |
| `exportPageImage` | `{ page, dpi?: 150, format: "png"\|"jpeg" }` | `{}` | out: image bytes |
| `registerFont` | `{ name }` | `{ name, family }` | in: TTF/OTF bytes |
| `getMetadata` | `{}` | `{ title, author, subject, keywords, creator, producer }` | |
| `setMetadata` | `{ title?, author?, subject?, keywords? }` | `{}` | |
| `undo` / `redo` | `{}` | `DocInfo` | |
| `save` | `SaveOpts` | `{ size }` | out: PDF bytes |

### Types

```ts
type DocInfo = {
  pageCount: number, needsPassword: boolean, isPdf: true, encrypted: boolean,
  canUndo: boolean, canRedo: boolean, hasForms: boolean, title: string,
  pages: { width: number, height: number, rotation: number }[]   // displayed size in points
}

type TextLayout = { blocks: {
  bbox: Rect,
  lines: {
    id: string,            // "<block>-<line>", stable until the page changes
    bbox: Rect, dir: [number, number], wmode: 0 | 1,
    text: string,
    spans: { text: string, bbox: Rect, font: string, size: number, color: Color,
             bold: boolean, italic: boolean, serif: boolean, mono: boolean,
             origin: Point }[]          // origin = baseline start of span
    chars: Quad[]                       // one quad per UTF-32 char of `text`
  }[]
}[] }

type FontName = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique"
  | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic"
  | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique"
  | string /* name given to registerFont */

type ReplaceTextReq = {
  page: number,
  bbox: Rect,              // area whose existing text is removed (usually a line bbox)
  text: string,            // replacement; "\n" starts a new line below
  origin?: Point,          // baseline start for new text; default = first removed char origin
  dir?: [number, number],  // text direction; default = original
  size?: number, color?: Color,
  font?: FontName | "original"   // default "original": reuse embedded font when it has every glyph, else closest standard font
  lineHeight?: number      // multiple of size, default 1.2
}

type AnnotType = "Text" | "FreeText" | "Square" | "Circle" | "Line" | "Ink" | "Polygon" | "PolyLine"
  | "Highlight" | "Underline" | "StrikeOut" | "Squiggly" | "Stamp" | "Redact"

type AnnotSpec = {
  type: AnnotType,
  rect?: Rect,              // Square/Circle/FreeText/Stamp/Text/Redact
  quads?: Quad[],           // Highlight/Underline/StrikeOut/Squiggly
  ink?: Point[][],          // Ink
  points?: Point[],         // Polygon/PolyLine; Line uses first two
  color?: Color,            // stroke / text color
  fill?: Color | null,      // interior
  opacity?: number,         // 0..1
  borderWidth?: number,
  contents?: string,        // FreeText text / note text
  font?: "Helv" | "TiRo" | "Cour", fontSize?: number,
  align?: 0 | 1 | 2,
  lineEnding?: ["None"|"OpenArrow"|"ClosedArrow"|"Circle"|"Square", same],
  author?: string,
  image?: boolean           // Stamp: use bytes-in image as appearance
}

type Annot = AnnotSpec & { id: number, rect: Rect }
type Field = { id: number, name: string, type: "text"|"checkbox"|"radio"|"combo"|"list"|"signature"|"button",
  rect: Rect, value: string, options: string[], readOnly: boolean, multiline: boolean, checked: boolean }

type SaveOpts = {
  flatten?: boolean,        // bake annotations and form fields into page content
  garbage?: 0..4 = 3,       // object cleanup level
  compress?: boolean = true,
  compressImages?: boolean = false, imageDpi?: number = 150,   // downsample images above imageDpi
  linearize?: false,
  encrypt?: { userPassword?: string, ownerPassword: string,
              permissions?: { print?: bool, copy?: bool, edit?: bool, annotate?: bool, forms?: bool } },
  decrypt?: boolean         // save without encryption (requires the document to be authenticated)
}
```

All mutating methods are journaled: `undo`/`redo` step one method call at a time.
Saving never modifies the live document, so undo/redo keep working after `save`.

## Encryption on save

* default: an unencrypted file stays unencrypted. An encrypted file is re-encrypted with
  AES-256, the same open password and the same permission bits. The original owner
  password cannot be recovered, so a random one is set. Saving never removes the
  password needed to open a file unless `decrypt: true` is passed.
* `encrypt: {...}` sets new passwords/permissions; `decrypt: true` removes encryption.

## Fonts (host contract)

The wasm build ships only the standard 14 fonts. For other scripts the engine
calls the host synchronously for a font file by name:

```js
const Module = await createPdfEngine({ pdfeditFetchFont: (file) => Uint8Array | null });
```

The web worker serves them with a synchronous XHR from `engine/fonts/<file>` (copied
there by `make wasm`). Each file is requested at most once per page load.

## Known limits (by design of the underlying engine)

* Legacy binary Office (`.doc`, `.xls`, `.ppt`) and OpenDocument (`.odt`...) are not convertible.
* XLSX cells using inline strings (rare) are not rendered; shared strings (what Excel writes) are.
* Text written by `replaceText`/`addText` is not shaped: right-to-left and complex scripts
  (Arabic joining, Devanagari conjuncts) are drawn as separate glyphs.
