// Mock of the WebAssembly engine (same surface as Module.Document from contracts/engine-api.md).
// Used with ?mock=1 for UI development and e2e tests. Renders with OffscreenCanvas so
// pages, text and annotations are visible. Saved files are "%MOCKSTATE\n" + JSON so they round-trip.

const PASSWORD = 'secret';
const MUTATING = new Set([
  'replaceText', 'addText', 'addImage', 'addAnnotation', 'updateAnnotation', 'deleteAnnotation',
  'setFieldValue', 'addField', 'deleteField', 'redact', 'rotatePages', 'deletePages', 'reorderPages',
  'insertBlankPage', 'insertDocument', 'setMetadata',
]);

class EngineErr extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let measureCtx = null;
function ctx2d() {
  if (!measureCtx) measureCtx = new OffscreenCanvas(4, 4).getContext('2d');
  return measureCtx;
}
function fontCss(size, f = 'Helvetica') {
  const bold = /Bold/.test(f) ? 'bold ' : '';
  const italic = /Italic|Oblique/.test(f) ? 'italic ' : '';
  const fam = /Times|TiRo/.test(f) ? 'serif' : /Courier|Cour/.test(f) ? 'monospace' : 'sans-serif';
  return `${italic}${bold}${size}px ${fam}`;
}
function textFromBytes(bytes, n = 4096) {
  if (!bytes) return '';
  return new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(n, bytes.length)));
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function intersects(a, b) { return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }
function css(c, a = 1) {
  if (!c) return null;
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

function defaultPage(n, withForms) {
  const page = {
    width: 612, height: 792, rotation: 0, label: `Page ${n + 1}`,
    lines: [
      { text: `Mock document page ${n + 1}`, x: 72, y: 96, size: 22, color: [0.1, 0.1, 0.3], font: 'Helvetica-Bold' },
      { text: 'The quick brown fox jumps over the lazy dog.', x: 72, y: 140, size: 14, color: [0, 0, 0], font: 'Helvetica' },
      { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.', x: 72, y: 164, size: 14, color: [0, 0, 0], font: 'Times-Roman' },
      { text: `Invoice number ${1000 + n} is due on Friday.`, x: 72, y: 188, size: 14, color: [0.6, 0, 0], font: 'Helvetica' },
      { text: 'Courier line for monospace testing 0123456789', x: 72, y: 212, size: 12, color: [0, 0, 0], font: 'Courier' },
    ],
    annots: [], fields: [], images: [], blacks: [],
  };
  if (withForms && n === 0) {
    page.fields.push(
      { id: 9001, name: 'full_name', type: 'text', rect: [72, 600, 300, 622], value: '', options: [], readOnly: false, multiline: false, checked: false },
      { id: 9002, name: 'agree', type: 'checkbox', rect: [72, 640, 86, 654], value: 'Off', options: [], readOnly: false, multiline: false, checked: false },
      { id: 9003, name: 'country', type: 'combo', rect: [72, 670, 220, 690], value: 'Nigeria', options: ['Nigeria', 'Ghana', 'Kenya'], readOnly: false, multiline: false, checked: false },
    );
  }
  return page;
}

class MockDocument {
  constructor() {
    this.state = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastBytes = null;
    this.locked = false;
    this.fonts = [];
  }

  call(method, argsJson, bytes) {
    this.lastBytes = null;
    try {
      const args = JSON.parse(argsJson || '{}');
      const fn = this['m_' + method];
      if (!fn) throw new EngineErr('bad_args', `Unknown method: ${method}`);
      if (!['version', 'open', 'authenticate', 'create', 'formats'].includes(method)) {
        if (!this.state) throw new EngineErr('no_document', 'No document is open');
        if (this.locked) throw new EngineErr('needs_password', 'Document is password protected');
      }
      let result;
      if (MUTATING.has(method)) {
        const snap = JSON.stringify(this.state);
        result = fn.call(this, args, bytes);
        this.undoStack.push(snap);
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack = [];
        if (result && typeof result.pageCount === 'number') result = this.docInfo(); // DocInfo reflects post-op journal
      } else {
        result = fn.call(this, args, bytes);
      }
      return JSON.stringify({ ok: true, result: result ?? {} });
    } catch (e) {
      return JSON.stringify({ ok: false, error: { code: e.code || 'mupdf', message: e.message || String(e) } });
    }
  }

  takeBytes() { const b = this.lastBytes; this.lastBytes = null; return b; }
  delete() { this.state = null; }

  // ---- helpers
  page(i) {
    const p = this.state.pages[i];
    if (!Number.isInteger(i) || !p) throw new EngineErr('bad_page', `Page ${i} out of range`);
    return p;
  }
  dims(p) {
    const rot = p.rotation % 180 !== 0;
    return { width: rot ? p.height : p.width, height: rot ? p.width : p.height };
  }
  docInfo() {
    const s = this.state;
    return {
      pageCount: this.locked ? 0 : s.pages.length,
      needsPassword: this.locked,
      isPdf: true,
      encrypted: !!s.encrypted,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      hasForms: !this.locked && s.pages.some((p) => p.fields.length > 0),
      title: s.meta.title || '',
      pages: this.locked ? [] : s.pages.map((p) => ({ ...this.dims(p), rotation: p.rotation })),
    };
  }
  newId() { return this.state.nextId++; }
  parseDoc(bytes, name) {
    const text = textFromBytes(bytes, bytes ? bytes.length : 0);
    if (text.startsWith('%MOCKSTATE\n')) return JSON.parse(text.slice(11));
    if (!text.startsWith('%PDF') && !/\.(png|jpe?g|tiff?|xps|epub|cbz|gif|bmp|docx|xlsx|pptx|html?|md|txt|svg)$/i.test(name || '')) {
      throw new EngineErr('mupdf', 'cannot recognize document format');
    }
    const m = text.match(/%MOCKPAGES (\d+)/);
    const count = m ? parseInt(m[1], 10) : /\.(png|jpe?g|gif|bmp)$/i.test(name || '') ? 1 : 3;
    const withForms = !/%MOCKNOFORMS/.test(text);
    return {
      pages: Array.from({ length: count }, (_, i) => defaultPage(i, withForms)),
      meta: { title: (name || '').replace(/\.[^.]+$/, ''), author: 'Mock Author', subject: '', keywords: '', creator: 'mock', producer: 'mock-engine' },
      nextId: 100,
      encrypted: /\/Encrypt|%MOCKLOCKED/.test(text) || /locked/i.test(name || ''),
    };
  }
  lineLayout(l) {
    const c = ctx2d();
    c.font = fontCss(l.size, l.font);
    const chars = [];
    const asc = l.size * 0.8, desc = l.size * 0.22;
    let x = l.x;
    for (const ch of Array.from(l.text)) {
      const w = c.measureText(ch).width;
      chars.push([x, l.y - asc, x + w, l.y - asc, x, l.y + desc, x + w, l.y + desc]);
      x += w;
    }
    return { bbox: [l.x, l.y - asc, x, l.y + desc], chars };
  }

  // ---- methods
  m_version() { return { api: 1, mupdf: 'mock' }; }

  m_open({ name, password }, bytes) {
    if (!bytes || !bytes.length) throw new EngineErr('bad_args', 'open requires file bytes');
    this.state = this.parseDoc(bytes, name);
    this.undoStack = []; this.redoStack = [];
    this.locked = !!this.state.encrypted;
    if (this.locked && password) return this.m_authenticate({ password });
    return this.docInfo();
  }
  m_create({ pages = 1, pageSize = 'A4' } = {}) {
    const sizes = { A4: [595, 842], Letter: [612, 792], Legal: [612, 1008], A3: [842, 1191], A5: [420, 595] };
    const [width, height] = Array.isArray(pageSize) ? pageSize : sizes[pageSize] || [];
    if (!width) throw new EngineErr('bad_args', `unknown pageSize '${pageSize}'`);
    if (!(pages >= 1 && pages <= 1000)) throw new EngineErr('bad_args', 'pages must be in [1, 1000]');
    this.state = { encrypted: false, nextId: 100, meta: { title: '', author: '', subject: '', keywords: '', creator: 'mock', producer: 'mock-engine' }, pages: [] };
    for (let i = 0; i < pages; i++) this.state.pages.push({ width, height, rotation: 0, label: 'blank', lines: [], annots: [], fields: [], images: [], blacks: [] });
    this.undoStack = []; this.redoStack = []; this.locked = false;
    return this.docInfo();
  }
  m_formats() {
    return { extensions: ['pdf', 'xps', 'oxps', 'epub', 'mobi', 'fb2', 'cbz', 'svg', 'html', 'htm', 'xhtml', 'txt', 'md', 'docx', 'xlsx', 'pptx', 'hwpx', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'pnm', 'jxr', 'psd'] };
  }
  m_authenticate({ password }) {
    if (!this.state) throw new EngineErr('no_document', 'No document is open');
    if (this.locked && password !== PASSWORD) throw new EngineErr('bad_password', 'Incorrect password');
    this.locked = false;
    return this.docInfo();
  }
  m_info() { return this.docInfo(); }

  m_render({ page, scale = 1, annots = true, widgets = true }) {
    const p = this.page(page);
    const { width, height } = this.dims(p);
    const W = Math.max(1, Math.round(width * scale)), H = Math.max(1, Math.round(height * scale));
    const cv = new OffscreenCanvas(W, H);
    const c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    c.scale(scale, scale);
    // big faint page number
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.font = 'bold 200px sans-serif';
    c.textAlign = 'center';
    c.fillText(String(page + 1), width / 2, height / 2 + 70);
    c.textAlign = 'left';
    if (p.rotation) { c.fillStyle = '#888'; c.font = '10px sans-serif'; c.fillText(`rotated ${p.rotation}°`, 8, height - 8); }
    for (const l of p.lines) {
      c.fillStyle = css(l.color);
      c.font = fontCss(l.size, l.font);
      c.fillText(l.text, l.x, l.y);
    }
    for (const im of p.images) {
      c.fillStyle = '#dde'; c.fillRect(im.rect[0], im.rect[1], im.rect[2] - im.rect[0], im.rect[3] - im.rect[1]);
      c.strokeStyle = '#99a'; c.strokeRect(im.rect[0], im.rect[1], im.rect[2] - im.rect[0], im.rect[3] - im.rect[1]);
    }
    for (const b of p.blacks) { c.fillStyle = css(b.fill); c.fillRect(b.rect[0], b.rect[1], b.rect[2] - b.rect[0], b.rect[3] - b.rect[1]); }
    if (annots) for (const a of p.annots) this.drawAnnot(c, a);
    if (widgets) for (const f of p.fields) {
      c.strokeStyle = '#36c'; c.fillStyle = 'rgba(200,220,255,0.5)';
      c.fillRect(f.rect[0], f.rect[1], f.rect[2] - f.rect[0], f.rect[3] - f.rect[1]);
      c.strokeRect(f.rect[0], f.rect[1], f.rect[2] - f.rect[0], f.rect[3] - f.rect[1]);
      c.fillStyle = '#000'; c.font = '11px sans-serif';
      c.fillText(f.type === 'checkbox' ? (f.checked ? '✓' : '') : f.value, f.rect[0] + 2, f.rect[3] - 5);
    }
    const data = c.getImageData(0, 0, W, H).data;
    this.lastBytes = new Uint8Array(data.buffer.slice(0));
    return { width: W, height: H };
  }

  drawAnnot(c, a) {
    const [x0, y0, x1, y1] = a.rect;
    c.save();
    c.globalAlpha = a.opacity ?? 1;
    c.lineWidth = a.borderWidth ?? 1;
    c.strokeStyle = css(a.color || [1, 0, 0]);
    const fill = a.fill ? css(a.fill) : null;
    switch (a.type) {
      case 'Square':
        if (fill) { c.fillStyle = fill; c.fillRect(x0, y0, x1 - x0, y1 - y0); }
        c.strokeRect(x0, y0, x1 - x0, y1 - y0); break;
      case 'Circle':
        c.beginPath(); c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
        if (fill) { c.fillStyle = fill; c.fill(); } c.stroke(); break;
      case 'Line': case 'PolyLine': case 'Polygon': {
        const pts = a.points || [[x0, y0], [x1, y1]];
        c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        if (a.type === 'Polygon') c.closePath();
        c.stroke();
        if (a.type === 'Line' && a.lineEnding?.[1] && a.lineEnding[1] !== 'None' && pts.length >= 2) {
          const [p, q] = [pts[0], pts[1]];
          const ang = Math.atan2(q[1] - p[1], q[0] - p[0]); const L = 10 + c.lineWidth * 2;
          c.beginPath(); c.moveTo(q[0], q[1]);
          c.lineTo(q[0] - L * Math.cos(ang - 0.4), q[1] - L * Math.sin(ang - 0.4));
          c.moveTo(q[0], q[1]);
          c.lineTo(q[0] - L * Math.cos(ang + 0.4), q[1] - L * Math.sin(ang + 0.4)); c.stroke();
        }
        break;
      }
      case 'Ink':
        c.lineCap = 'round'; c.lineJoin = 'round';
        for (const s of a.ink || []) { c.beginPath(); s.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); }
        break;
      case 'Highlight':
        c.fillStyle = css(a.color || [1, 1, 0]); c.globalAlpha = Math.min(a.opacity ?? 1, 0.4);
        for (const q of a.quads || []) c.fillRect(q[0], q[1], q[2] - q[0], q[5] - q[1]);
        break;
      case 'Underline': case 'StrikeOut': case 'Squiggly':
        for (const q of a.quads || []) {
          const y = a.type === 'StrikeOut' ? (q[1] + q[5]) / 2 : q[5] - 1;
          c.beginPath(); c.moveTo(q[0], y); c.lineTo(q[2], y); c.stroke();
        }
        break;
      case 'FreeText':
        c.fillStyle = css(a.color || [0, 0, 0]);
        c.font = fontCss(a.fontSize || 12, a.font || 'Helv');
        (a.contents || '').split('\n').forEach((ln, i) => c.fillText(ln, x0 + 2, y0 + (a.fontSize || 12) * (1 + i * 1.2)));
        break;
      case 'Text':
        c.fillStyle = css(a.color || [1, 0.8, 0]); c.fillRect(x0, y0, x1 - x0, y1 - y0);
        c.strokeStyle = '#a80'; c.strokeRect(x0, y0, x1 - x0, y1 - y0);
        break;
      case 'Stamp':
        c.fillStyle = 'rgba(120,140,200,0.25)'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
        c.strokeStyle = '#558'; c.strokeRect(x0, y0, x1 - x0, y1 - y0);
        c.fillStyle = '#336'; c.font = '10px sans-serif'; c.fillText(a.image ? 'IMAGE' : (a.contents || 'STAMP'), x0 + 4, y0 + 14);
        break;
      case 'Redact':
        c.strokeStyle = 'red'; c.strokeRect(x0, y0, x1 - x0, y1 - y0); break;
      default: break;
    }
    c.restore();
  }

  m_textLayout({ page }) {
    const p = this.page(page);
    const blocks = p.lines.map((l, i) => {
      const { bbox, chars } = this.lineLayout(l);
      const font = l.font || 'Helvetica';
      return {
        bbox,
        lines: [{
          id: `${i}-0`, bbox, dir: [1, 0], wmode: 0, text: l.text,
          spans: [{
            text: l.text, bbox, font, size: l.size, color: l.color,
            bold: /Bold/.test(font), italic: /Italic|Oblique/.test(font), serif: /Times/.test(font), mono: /Courier/.test(font),
            origin: [l.x, l.y],
          }],
          chars,
        }],
      };
    });
    return { blocks };
  }

  m_search({ page, needle, max = 500 }) {
    const p = this.page(page);
    const hits = [];
    if (!needle) return { hits };
    const n = needle.toLowerCase();
    for (const l of p.lines) {
      const { chars } = this.lineLayout(l);
      const chArr = Array.from(l.text.toLowerCase());
      const t = chArr.join('');
      let idx = t.indexOf(n);
      while (idx >= 0 && hits.length < max) {
        const ci = Array.from(t.slice(0, idx)).length, cl = Array.from(n).length;
        const a = chars[ci], b = chars[ci + cl - 1];
        hits.push([[a[0], a[1], b[2], b[3], a[4], a[5], b[6], b[7]]]);
        idx = t.indexOf(n, idx + 1);
      }
    }
    return { hits };
  }

  m_replaceText({ page, bbox, text, origin, size, color, font = 'original', lineHeight = 1.2 }) {
    const p = this.page(page);
    if (!bbox || typeof text !== 'string') throw new EngineErr('bad_args', 'replaceText needs bbox and text');
    const removed = p.lines.filter((l) => intersects(this.lineLayout(l).bbox, bbox));
    const first = removed[0];
    p.lines = p.lines.filter((l) => !removed.includes(l));
    const o = origin || (first ? [first.x, first.y] : [bbox[0], bbox[3] - 2]);
    const sz = size || first?.size || 12;
    const usedFont = font === 'original' ? (first?.font || 'Helvetica') : font;
    text.split('\n').forEach((t, i) => {
      if (t.length) p.lines.push({ text: t, x: o[0], y: o[1] + i * sz * lineHeight, size: sz, color: color || first?.color || [0, 0, 0], font: usedFont });
    });
    return { ok: true, font: usedFont, usedOriginalFont: font === 'original' };
  }

  m_addText({ page, x, y, text, size = 12, color = [0, 0, 0], font = 'Helvetica', lineHeight = 1.2 }) {
    const p = this.page(page);
    String(text).split('\n').forEach((t, i) => p.lines.push({ text: t, x, y: y + i * size * lineHeight, size, color, font }));
    return {};
  }

  m_addImage({ page, rect }, bytes) {
    if (!bytes) throw new EngineErr('bad_args', 'addImage needs image bytes');
    this.page(page).images.push({ rect });
    return {};
  }

  m_listAnnotations({ page }) { return { annots: clone(this.page(page).annots) }; }

  m_addAnnotation({ page, ...spec }, bytes) {
    const p = this.page(page);
    const types = ['Text', 'FreeText', 'Square', 'Circle', 'Line', 'Ink', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Stamp', 'Redact'];
    if (!types.includes(spec.type)) throw new EngineErr('unsupported', `Unsupported annotation type ${spec.type}`);
    if (spec.type === 'Stamp' && spec.image && !bytes) throw new EngineErr('bad_args', 'Stamp image needs bytes');
    let rect = spec.rect;
    if (!rect && spec.quads?.length) rect = spec.quads.map(quadRect).reduce(union);
    if (!rect && spec.ink?.length) rect = pad(spec.ink.flat().map((pt) => [pt[0], pt[1], pt[0], pt[1]]).reduce(union), (spec.borderWidth || 1) + 2);
    if (!rect && spec.points?.length) rect = pad(spec.points.map((pt) => [pt[0], pt[1], pt[0], pt[1]]).reduce(union), 6);
    if (!rect) throw new EngineErr('bad_args', 'Annotation needs geometry');
    const a = { color: [1, 0, 0], opacity: 1, borderWidth: 1, ...spec, rect, id: this.newId() };
    p.annots.push(a);
    return { id: a.id };
  }

  m_updateAnnotation({ page, id, ...spec }) {
    const a = this.page(page).annots.find((x) => x.id === id);
    if (!a) throw new EngineErr('not_found', `Annotation ${id} not found`);
    Object.assign(a, spec);
    return {};
  }

  m_deleteAnnotation({ page, id }) {
    const p = this.page(page);
    const i = p.annots.findIndex((x) => x.id === id);
    if (i < 0) throw new EngineErr('not_found', `Annotation ${id} not found`);
    p.annots.splice(i, 1);
    return {};
  }

  m_listFields({ page }) { return { fields: clone(this.page(page).fields) }; }

  m_setFieldValue({ page, id, value }) {
    const f = this.page(page).fields.find((x) => x.id === id);
    if (!f) throw new EngineErr('not_found', `Field ${id} not found`);
    if (f.readOnly) throw new EngineErr('unsupported', 'Field is read-only');
    if (f.type === 'checkbox' || f.type === 'radio') {
      f.checked = value === true || value === 'Yes' || value === 'On';
      f.value = f.checked ? 'Yes' : 'Off';
    } else f.value = String(value);
    return {};
  }

  m_addField({ page, type, rect, name, options = [], value = '', multiline = false }) {
    const p = this.page(page);
    if (!['text', 'checkbox', 'combo', 'list', 'radio', 'signature'].includes(type)) throw new EngineErr('bad_args', `Bad field type ${type}`);
    const id = this.newId();
    const nm = name || `${type}_${id}`;
    p.fields.push({ id, name: nm, type, rect, value: String(value), options, readOnly: false, multiline, checked: false });
    return { id, name: nm };
  }

  m_deleteField({ page, id }) {
    const p = this.page(page);
    const i = p.fields.findIndex((x) => x.id === id);
    if (i < 0) throw new EngineErr('not_found', `Field ${id} not found`);
    p.fields.splice(i, 1);
    return {};
  }

  m_redact({ page, rects, fill = [0, 0, 0], images = true }) {
    const p = this.page(page);
    if (!Array.isArray(rects) || !rects.length) throw new EngineErr('bad_args', 'redact needs rects');
    for (const r of rects) {
      p.lines = p.lines.filter((l) => !intersects(this.lineLayout(l).bbox, r));
      if (images) p.images = p.images.filter((im) => !intersects(im.rect, r));
      p.annots = p.annots.filter((a) => !intersects(a.rect, r));
      if (fill) p.blacks.push({ rect: r, fill });
    }
    return {};
  }

  m_rotatePages({ pages, degrees }) {
    if (![90, 180, 270, -90].includes(degrees)) throw new EngineErr('bad_args', 'degrees must be 90, 180, 270 or -90');
    for (const i of pages) { const p = this.page(i); p.rotation = (((p.rotation + degrees) % 360) + 360) % 360; }
    return this.docInfo();
  }

  m_deletePages({ pages }) {
    const set = new Set(pages);
    for (const i of set) this.page(i);
    if (set.size >= this.state.pages.length) throw new EngineErr('bad_args', 'Cannot delete every page');
    this.state.pages = this.state.pages.filter((_, i) => !set.has(i));
    return this.docInfo();
  }

  m_reorderPages({ order }) {
    if (!Array.isArray(order) || !order.length) throw new EngineErr('bad_args', 'order must be a non-empty array');
    const old = this.state.pages;
    this.state.pages = order.map((i) => { if (!old[i]) throw new EngineErr('bad_page', `Page ${i} out of range`); return clone(old[i]); });
    return this.docInfo();
  }

  m_insertBlankPage({ at, width = 595, height = 842 }) {
    const pages = this.state.pages;
    const pos = Math.max(0, Math.min(pages.length, at ?? pages.length));
    pages.splice(pos, 0, { width, height, rotation: 0, label: 'blank', lines: [], annots: [], fields: [], images: [], blacks: [] });
    return this.docInfo();
  }

  m_insertDocument({ at, password, name }, bytes) {
    if (!bytes) throw new EngineErr('bad_args', 'insertDocument needs bytes');
    const other = this.parseDoc(bytes, name || "other.pdf");
    if (other.encrypted && password !== PASSWORD) throw new EngineErr(password ? 'bad_password' : 'needs_password', 'Inserted document is password protected');
    const pages = this.state.pages;
    const pos = Math.max(0, Math.min(pages.length, at ?? pages.length));
    for (const p of other.pages) for (const a of p.annots) a.id = this.newId();
    for (const p of other.pages) for (const f of p.fields) f.id = this.newId();
    pages.splice(pos, 0, ...other.pages);
    return this.docInfo();
  }

  serialize(pages, extra = {}) {
    const st = { ...clone(this.state), pages: clone(pages), ...extra };
    return new TextEncoder().encode('%MOCKSTATE\n' + JSON.stringify(st));
  }

  m_extractPages({ pages }) {
    if (!pages?.length) throw new EngineErr('bad_args', 'pages required');
    this.lastBytes = this.serialize(pages.map((i) => this.page(i)), { encrypted: false });
    return {};
  }

  m_exportPageImage({ page, format = 'png' }) {
    this.page(page);
    // Minimal valid 1x1 PNG / JPEG-ish header; real engine returns a full image.
    const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
    this.lastBytes = format === 'jpeg' ? new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 255, 217]) : new Uint8Array(png);
    return {};
  }

  m_registerFont({ name }, bytes) {
    if (!bytes || !name) throw new EngineErr('bad_args', 'registerFont needs name and bytes');
    this.fonts.push(name);
    return { name, family: name };
  }

  m_getMetadata() {
    const m = this.state.meta;
    return { title: m.title || '', author: m.author || '', subject: m.subject || '', keywords: m.keywords || '', creator: m.creator || '', producer: m.producer || '' };
  }
  m_setMetadata(args) {
    for (const k of ['title', 'author', 'subject', 'keywords']) if (typeof args[k] === 'string') this.state.meta[k] = args[k];
    return {};
  }

  m_undo() {
    if (!this.undoStack.length) throw new EngineErr('bad_args', 'Nothing to undo');
    this.redoStack.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.undoStack.pop());
    return this.docInfo();
  }
  m_redo() {
    if (!this.redoStack.length) throw new EngineErr('bad_args', 'Nothing to redo');
    this.undoStack.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.redoStack.pop());
    return this.docInfo();
  }

  m_save(opts = {}) {
    let pages = clone(this.state.pages);
    if (opts.flatten) {
      for (const p of pages) {
        for (const a of p.annots) if (a.type === 'FreeText') (a.contents || '').split('\n').forEach((t, i) => p.lines.push({ text: t, x: a.rect[0] + 2, y: a.rect[1] + (a.fontSize || 12) * (1 + i * 1.2), size: a.fontSize || 12, color: a.color || [0, 0, 0], font: 'Helvetica' }));
        p.annots = [];
        p.fields = [];
      }
    }
    const encrypted = opts.encrypt ? true : opts.decrypt ? false : !!this.state.encrypted;
    const bytes = this.serialize(pages, { encrypted, saveOpts: opts });
    this.lastBytes = bytes;
    return { size: bytes.length };
  }
}

function quadRect(q) { return [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])]; }
function union(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }
function pad(r, d) { return [r[0] - d, r[1] - d, r[2] + d, r[3] + d]; }

export default async function createPdfEngine() {
  return { Document: MockDocument };
}
