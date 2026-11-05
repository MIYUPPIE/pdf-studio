// Redaction: mark areas (pending, red hatched), then apply permanently via engine `redact`.
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { rectFromPoints, rectWidth, rectHeight, round2, hexToRgb } from '../geometry.js';
import { confirmDialog, toast } from '../dialogs.js';

export class RedactTool {
  constructor(app) { this.app = app; this.name = 'redact'; this.drag = null; }
  activate() { this.updateBar(); }
  deactivate() { this.drag?.el.remove(); this.drag = null; }
  onDown(v, pt, e) {
    if (e.button !== 0 || e.target.closest('.redact-pending')) return;
    e.preventDefault();
    v.overlay.setPointerCapture(e.pointerId);
    const el = document.createElement('div');
    el.className = 'preview-rect';
    v.toolLayer.appendChild(el);
    this.drag = { v, start: pt, el };
    placeEl(el, rectFromPoints(pt, pt));
  }
  onMove(v, pt) {
    if (!this.drag || this.drag.v !== v) return;
    this.drag.end = pt;
    placeEl(this.drag.el, rectFromPoints(this.drag.start, pt));
  }
  onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.el.remove();
    if (!d.end) return;
    const r = rectFromPoints(d.start, d.end).map(round2);
    if (rectWidth(r) < 2 || rectHeight(r) < 2) return;
    const list = state.redactions.get(d.v.index) || [];
    list.push({ rect: r });
    state.redactions.set(d.v.index, list);
    this.app.renderRedactions(d.v);
    this.updateBar();
  }
  updateBar() { this.app.updateRedactBar(); }
}

/** Render pending redaction boxes for a page (called by viewer on visibility and by the tool). */
export function renderRedactions(app, v) {
  v.toolLayer.querySelectorAll('.redact-pending').forEach((n) => n.remove());
  const list = state.redactions.get(v.index) || [];
  list.forEach((r, i) => {
    const el = placeEl(document.createElement('div'), r.rect);
    el.className += ' redact-pending';
    el.title = 'Pending redaction';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '×';
    b.setAttribute('aria-label', 'Remove this redaction mark');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      list.splice(i, 1);
      if (!list.length) state.redactions.delete(v.index);
      renderRedactions(app, v);
      app.updateRedactBar();
    });
    el.appendChild(b);
    v.toolLayer.appendChild(el);
  });
}

export async function applyRedactions(app) {
  const total = [...state.redactions.values()].reduce((n, l) => n + l.length, 0);
  if (!total) return;
  const ok = await confirmDialog('Apply redactions?',
    `${total} marked area${total > 1 ? 's' : ''} will be permanently removed: text, images and graphics underneath are deleted from the file, not just covered. You can still undo before downloading.`,
    'Apply redactions', true);
  if (!ok) return;
  const fill = hexToRgb(state.toolProps.redact.fill || '#000000');
  const entries = [...state.redactions.entries()];
  state.redactions.clear();
  for (const [page, list] of entries) {
    await app.mutate('redact', { page, rects: list.map((r) => r.rect), fill, images: true, graphics: true }, null, { page });
  }
  for (const v of app.viewer.views) renderRedactions(app, v);
  app.updateRedactBar();
  toast(`Applied ${total} redaction${total > 1 ? 's' : ''}`, 'success');
}
