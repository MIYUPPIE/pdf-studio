// Smoke test of the real WebAssembly build (the exact artifact the browser loads).
// Run: node --test services/engine/tests/wasm_smoke.mjs   (after `make wasm`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.join(here, "../../web/engine/pdfengine.js");
const { default: createPdfEngine } = await import(enginePath);
const fontsRequested = [];
const Module = await createPdfEngine({
  // Same contract as the web worker's sync XHR: file name in, bytes (or null) out.
  pdfeditFetchFont(file) {
    fontsRequested.push(file);
    try { return new Uint8Array(readFileSync(path.join(path.dirname(enginePath), "fonts", file))); } catch { return null; }
  },
});

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

function call(doc, method, args = {}, bytes = null) {
  const res = JSON.parse(doc.call(method, JSON.stringify(args), bytes));
  if (!res.ok) throw Object.assign(new Error(`${method}: ${res.error.message}`), { code: res.error.code });
  return res.result;
}
function pageText(doc, page) {
  return call(doc, "textLayout", { page }).blocks.flatMap((b) => b.lines.map((l) => l.text)).join("\n");
}
function newDocWithText() {
  const doc = new Module.Document();
  call(doc, "open", { name: "seed.png" }, png(4, 4, [255, 255, 255]));
  call(doc, "insertBlankPage", { at: 0, width: 612, height: 792 });
  call(doc, "deletePages", { pages: [1] });
  call(doc, "addText", { page: 0, x: 72, y: 100, text: "Hello World", size: 24 });
  call(doc, "addText", { page: 0, x: 72, y: 150, text: "Second line", size: 12 });
  return doc;
}

test("version", () => {
  const doc = new Module.Document();
  assert.deepEqual(call(doc, "version"), { api: 1, mupdf: "1.28.6" });
  doc.delete();
});

test("errors come back as codes, never exceptions", () => {
  const doc = new Module.Document();
  const res = JSON.parse(doc.call("info", "{}", null));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "no_document");
  const bad = JSON.parse(doc.call("open", JSON.stringify({ name: "x.pdf" }), new Uint8Array([1, 2, 3])));
  assert.equal(bad.ok, false);
  doc.delete();
});

test("render returns RGBA bytes via takeBytes", () => {
  const doc = newDocWithText();
  const r = call(doc, "render", { page: 0, scale: 0.5 });
  const bytes = doc.takeBytes();
  assert.equal(r.width, 306);
  assert.equal(bytes.length, r.width * r.height * 4);
  assert.equal(bytes[0], 255);
  doc.delete();
});

test("edit existing text, undo, save, reopen", () => {
  const doc = newDocWithText();
  const line = call(doc, "textLayout", { page: 0 }).blocks.flatMap((b) => b.lines).find((l) => l.text.includes("Hello"));
  call(doc, "replaceText", { page: 0, bbox: line.bbox, text: "Edited in wasm" });
  assert.match(pageText(doc, 0), /Edited in wasm/);
  assert.doesNotMatch(pageText(doc, 0), /Hello World/);
  call(doc, "undo");
  assert.match(pageText(doc, 0), /Hello World/);
  call(doc, "redo");
  call(doc, "save", {});
  const saved = doc.takeBytes();
  const doc2 = new Module.Document();
  call(doc2, "open", { name: "saved.pdf" }, saved);
  assert.match(pageText(doc2, 0), /Edited in wasm/);
  assert.match(pageText(doc2, 0), /Second line/);
  doc.delete(); doc2.delete();
});

test("Yoruba diacritics survive an edit in the browser build", () => {
  const doc = newDocWithText();
  const line = call(doc, "textLayout", { page: 0 }).blocks.flatMap((b) => b.lines).find((l) => l.text.includes("Hello"));
  const yo = "Ọjọ́ ẹ̀kọ́ àti ìṣẹ́";
  call(doc, "replaceText", { page: 0, bbox: line.bbox, text: yo });
  const text = pageText(doc, 0).normalize("NFC");
  assert.ok(text.includes(yo.normalize("NFC")), `got: ${text}`);
  // And it is drawn (not tofu/blank): ink appears where the text is.
  const r = call(doc, "render", { page: 0, scale: 1 });
  const px = doc.takeBytes();
  let dark = 0;
  for (let y = 75; y < 105; y++) for (let x = 72; x < 300; x++) if (px[(y * r.width + x) * 4] < 128) dark++;
  assert.ok(dark > 200, `expected glyph ink, got ${dark} dark pixels`);
  assert.ok(fontsRequested.includes("NotoSerif-Regular.otf"), `fonts requested: ${fontsRequested}`);
  doc.delete();
});

test("formats, create, and converting HTML/Markdown/text to PDF", () => {
  const doc = new Module.Document();
  const { extensions } = call(doc, "formats");
  for (const ext of ["pdf", "docx", "xlsx", "pptx", "html", "md", "txt", "epub", "png", "svg"]) assert.ok(extensions.includes(ext), ext);
  const info = call(doc, "create", { pages: 2, pageSize: "A4" });
  assert.equal(info.pageCount, 2);
  const enc = new TextEncoder();
  call(doc, "insertDocument", { at: 2, name: "a.html" }, enc.encode("<h1>From HTML</h1>"));
  call(doc, "insertDocument", { at: 3, name: "b.md" }, enc.encode("# From Markdown\n\nbody"));
  const final = call(doc, "insertDocument", { at: 4, name: "c.txt" }, enc.encode("From plain text"));
  assert.equal(final.pageCount, 5);
  assert.match(pageText(doc, 2), /From HTML/);
  assert.match(pageText(doc, 3), /From Markdown/);
  assert.match(pageText(doc, 4), /From plain text/);
  doc.delete();
});

test("annotations, forms, redaction, page ops, encryption", () => {
  const doc = newDocWithText();
  const { id } = call(doc, "addAnnotation", { page: 0, type: "Square", rect: [100, 300, 200, 400], color: [1, 0, 0] });
  assert.equal(call(doc, "listAnnotations", { page: 0 }).annots[0].id, id);
  const stamp = call(doc, "addAnnotation", { page: 0, type: "Stamp", rect: [300, 300, 400, 400], image: true }, png(8, 8, [0, 0, 255]));
  assert.ok(stamp.id > 0);
  const f = call(doc, "addField", { page: 0, type: "text", rect: [100, 500, 300, 525], name: "who" });
  call(doc, "setFieldValue", { page: 0, id: f.id, value: "Ada" });
  assert.equal(call(doc, "listFields", { page: 0 }).fields[0].value, "Ada");
  const second = call(doc, "textLayout", { page: 0 }).blocks.flatMap((b) => b.lines).find((l) => l.text.includes("Second"));
  call(doc, "redact", { page: 0, rects: [second.bbox] });
  assert.doesNotMatch(pageText(doc, 0), /Second/);
  let info = call(doc, "insertBlankPage", { at: 1 });
  assert.equal(info.pageCount, 2);
  info = call(doc, "rotatePages", { pages: [1], degrees: 90 });
  assert.equal(info.pages[1].rotation, 90);
  call(doc, "save", { encrypt: { userPassword: "s3cret", ownerPassword: "own" } });
  const enc = doc.takeBytes();
  const d2 = new Module.Document();
  assert.equal(call(d2, "open", { name: "e.pdf" }, enc).needsPassword, true);
  assert.throws(() => call(d2, "authenticate", { password: "nope" }), (e) => e.code === "bad_password");
  info = call(d2, "authenticate", { password: "s3cret" });
  assert.equal(info.pageCount, 2);
  assert.equal(call(d2, "listFields", { page: 0 }).fields[0].value, "Ada");
  doc.delete(); d2.delete();
});
