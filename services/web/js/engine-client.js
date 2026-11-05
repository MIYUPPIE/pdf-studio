// Promise wrapper around the engine Web Worker.

export class EngineError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EngineError';
    this.code = code;
  }
}

export class EngineClient {
  /** @param {{mock?: boolean, workerUrl?: string|URL}} opts */
  constructor(opts = {}) {
    const url = opts.workerUrl || new URL(`./worker.js${opts.mock ? '?mock=1' : ''}`, import.meta.url);
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new EngineError('engine_load', e.message || 'The PDF engine failed to load. Build it with `make wasm`.');
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.loadError = err;
    };
  }

  #onMessage({ id, ok, result, error, bytes }) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (ok) p.resolve({ result, bytes: bytes ? new Uint8Array(bytes) : null });
    else p.reject(new EngineError(error?.code || 'mupdf', error?.message || 'Unknown engine error'));
  }

  /**
   * Call an engine method. Resolves to {result, bytes}. Input bytes are copied, so the caller keeps them.
   * @param {string} docId
   * @param {string} method
   * @param {object} [args]
   * @param {Uint8Array|ArrayBuffer|null} [bytes]
   */
  call(docId, method, args = {}, bytes = null) {
    if (this.loadError) return Promise.reject(this.loadError);
    const id = this.nextId++;
    let buf = null;
    if (bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      buf = u8.slice().buffer;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, docId, method, args, bytes: buf }, buf ? [buf] : []);
    });
  }

  close(docId) { return this.call(docId, '__close'); }
  ping() { return this.call('', '__ping'); }
  terminate() { this.worker.terminate(); }
}
