// Signature: create (draw / type / upload) in a modal, then click to place on a page.
import { state } from '../state.js';
import { modal, toast } from '../dialogs.js';
import { hexToRgb, round2, inkBounds } from '../geometry.js';
import { Ghost, loadImage } from './common.js';

const SIG_W = 160; // points

/** Open the signature dialog. Resolves {kind:'ink', strokes, w, h} | {kind:'image', bytes, w, h, url} | null */
export async function createSignature() {
  let mode = 'draw';
  let strokes = [];
  let uploaded = null;
  let typedCanvas = null;
  const body = `
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="draw" aria-selected="true">Draw</button>
      <button type="button" role="tab" data-tab="type" aria-selected="false">Type</button>
      <button type="button" role="tab" data-tab="upload" aria-selected="false">Upload</button>
    </div>
    <div data-panel="draw">
      <canvas class="sig-pad" width="900" height="360" aria-label="Signature drawing pad"></canvas>
      <div style="display:flex;justify-content:space-between;margin-top:6px"><span class="muted small">Draw with mouse, pen or finger</span><button type="button" class="btn sm-text" data-clear>Clear</button></div>
    </div>
    <div data-panel="type" hidden>
      <label class="f">Your name<input type="text" name="typed" autocomplete="name" placeholder="Jane Doe"></label>
      <div class="sig-typed" data-preview>&nbsp;</div>
    </div>
    <div data-panel="upload" hidden>
      <label class="f">Signature image (PNG with transparent background works best)<input type="file" name="sigfile" accept="image/png,image/jpeg"></label>
      <img data-upimg alt="" style="max-width:100%;max-height:160px;display:none">
    </div>`;
  const res = await modal({
    title: 'Create signature', body, ok: 'Use signature',
    onOpen: (form) => {
      const tabs = form.querySelectorAll('[data-tab]');
      tabs.forEach((t) => t.addEventListener('click', () => {
        mode = t.dataset.tab;
        tabs.forEach((x) => x.setAttribute('aria-selected', x === t));
        form.querySelectorAll('[data-panel]').forEach((pnl) => { pnl.hidden = pnl.dataset.panel !== mode; });
        if (mode === 'type') form.querySelector('[name=typed]').focus();
      }));
      // drawing pad
      const cv = form.querySelector('.sig-pad');
      const ctx = cv.getContext('2d');
      ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
      let cur = null;
      const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
      cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); cur = [pos(e)]; strokes.push(cur); ctx.beginPath(); ctx.moveTo(...cur[0]); });
      cv.addEventListener('pointermove', (e) => { if (!cur) return; const pt = pos(e); cur.push(pt); ctx.lineTo(...pt); ctx.stroke(); });
      const end = () => { cur = null; };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      form.querySelector('[data-clear]').addEventListener('click', () => { strokes = []; ctx.clearRect(0, 0, cv.width, cv.height); });
      // typed
      const typed = form.querySelector('[name=typed]');
      const prev = form.querySelector('[data-preview]');
      typed.addEventListener('input', () => { prev.textContent = typed.value || ' '; });
      // upload
      form.querySelector('[name=sigfile]').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        uploaded = await loadImage(f);
        const img = form.querySelector('[data-upimg]');
        img.src = uploaded.url; img.style.display = 'block';
      });
    },
    validate: async (data) => {
      if (mode === 'draw' && !strokes.some((s) => s.length > 0)) return 'Draw your signature first';
      if (mode === 'type') {
        if (!data.typed.trim()) return 'Type your name first';
        typedCanvas = await renderTyped(data.typed.trim());
      }
      if (mode === 'upload' && !uploaded) return 'Choose an image first';
      return '';
    },
  });
  if (!res) return null;
  if (mode === 'draw') {
    const b = inkBounds(strokes, 4);
    const strokesN = strokes.filter((s) => s.length).map((s) => s.map(([x, y]) => [x - b[0], y - b[1]]));
    return { kind: 'ink', strokes: strokesN, w: b[2] - b[0], h: b[3] - b[1] };
  }
  if (mode === 'type') return typedCanvas;
  return { kind: 'image', ...uploaded };
}

async function renderTyped(name) {
  const font = '96px "Segoe Script", "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive';
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const w = Math.ceil(m.measureText(name).width + 40), h = 150;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.font = font; ctx.fillStyle = '#111'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 20, h / 2);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { kind: 'image', bytes: new Uint8Array(await blob.arrayBuffer()), w, h, url: URL.createObjectURL(blob) };
}

/** Annotation spec + bytes for a signature placed in rect. */
export function signatureSpec(sig, rect, pr) {
  if (sig.kind === 'ink') {
    const sx = (rect[2] - rect[0]) / sig.w, sy = (rect[3] - rect[1]) / sig.h;
    const ink = sig.strokes.map((s) => s.map(([x, y]) => [round2(rect[0] + x * sx), round2(rect[1] + y * sy)]));
    return { spec: { type: 'Ink', ink, color: hexToRgb(pr.color), borderWidth: Number(pr.width), opacity: 1 }, bytes: null };
  }
  return { spec: { type: 'Stamp', rect: rect.map(round2), image: true }, bytes: sig.bytes };
}

/** Fit signature aspect ratio into a target rect (centred). */
export function fitInto(sig, rect) {
  const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
  const s = Math.min(rw / sig.w, rh / sig.h);
  const w = sig.w * s, h = sig.h * s;
  const x = rect[0] + (rw - w) / 2, y = rect[1] + (rh - h) / 2;
  return [x, y, x + w, y + h];
}

export class SignatureTool {
  constructor(app) { this.app = app; this.name = 'signature'; this.ghost = null; }
  async activate() {
    if (!state.signature) await this.newSignature();
    else this.makeGhost();
  }
  deactivate() { this.ghost?.remove(); this.ghost = null; }
  async newSignature() {
    const sig = await createSignature();
    if (!sig) return false;
    state.signature = sig;
    this.makeGhost();
    toast('Click on a page to place your signature');
    this.app.props.render();
    return true;
  }
  makeGhost() {
    const sig = state.signature;
    if (!sig) return;
    this.ghost?.remove();
    const w = SIG_W, h = (SIG_W * sig.h) / sig.w;
    this.ghost = new Ghost(w, h, sig.url ? `<img alt="" src="${sig.url}">` : '');
  }
  onMove(v, pt) { this.ghost?.move(v, pt); }
  onLeave() { this.ghost?.remove(); this.makeGhost(); }
  async onDown(v, pt, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!state.signature) { await this.newSignature(); return; }
    const rect = this.ghost.rectAt(pt);
    await this.place(v.index, rect);
  }
  async place(page, rect) {
    const { spec, bytes } = signatureSpec(state.signature, rect, state.toolProps.signature);
    const res = await this.app.mutate('addAnnotation', { page, ...spec }, bytes, { page });
    if (res) {
      this.ghost?.remove();
      this.app.tools.set('select');
      await this.app.selection.select(page, res.id);
    }
    return res;
  }
}
