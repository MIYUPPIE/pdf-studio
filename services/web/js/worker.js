// Web Worker hosting the C++/WebAssembly engine (or the mock with ?mock=1).
// Protocol: main -> {id, docId, method, args, bytes?: ArrayBuffer}
//           worker -> {id, ok, result | error, bytes?: ArrayBuffer}   (ArrayBuffers are transferred)
// Special methods handled here: "__close" frees a Document, "__ping" checks the engine loaded.

const params = new URL(self.location.href).searchParams;
const useMock = params.get('mock') === '1';

const engineUrl = new URL('../engine/pdfengine.js', self.location.href);

// Fallback fonts (Noto for Yoruba/Vietnamese Latin, Arabic, Devanagari, CJK, ...)
// are not compiled into the wasm. The engine asks for a file the first time a
// script needs it; the request must be synchronous, which workers allow.
function fetchFontSync(file) {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', new URL(`fonts/${encodeURIComponent(file)}`, engineUrl).href, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    return xhr.status === 200 ? new Uint8Array(xhr.response) : null;
  } catch {
    return null;
  }
}

const modulePromise = (async () => {
  const mod = await import(useMock ? './mock-engine.js' : engineUrl.href);
  return mod.default({ pdfeditFetchFont: fetchFontSync });
})();

const docs = new Map();

function toTransferable(view) {
  if (!view) return null;
  const u8 = view instanceof Uint8Array ? view : new Uint8Array(view);
  // If the engine handed us a view into its heap, copy it so we never transfer wasm memory.
  const shared = typeof SharedArrayBuffer !== 'undefined' && u8.buffer instanceof SharedArrayBuffer;
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength && !shared) {
    return u8.buffer;
  }
  return u8.slice().buffer;
}

self.onmessage = async (e) => {
  const { id, docId, method, args, bytes } = e.data;
  try {
    const Module = await modulePromise;
    if (method === '__ping') {
      self.postMessage({ id, ok: true, result: { mock: useMock } });
      return;
    }
    if (method === '__close') {
      const d = docs.get(docId);
      if (d) { d.delete(); docs.delete(docId); }
      self.postMessage({ id, ok: true, result: {} });
      return;
    }
    let doc = docs.get(docId);
    if (!doc) { doc = new Module.Document(); docs.set(docId, doc); }
    const input = bytes ? new Uint8Array(bytes) : null;
    const res = JSON.parse(doc.call(method, JSON.stringify(args ?? {}), input));
    if (!res.ok) {
      self.postMessage({ id, ok: false, error: res.error });
      return;
    }
    const out = toTransferable(doc.takeBytes());
    self.postMessage({ id, ok: true, result: res.result, bytes: out }, out ? [out] : []);
  } catch (err) {
    const message = String(err?.message || err);
    const code = /Failed to fetch|import|Cannot find module|404/i.test(message) ? 'engine_load' : 'mupdf';
    self.postMessage({ id, ok: false, error: { code, message } });
  }
};
