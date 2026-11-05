// Text markup: Highlight / Underline / StrikeOut by dragging across text.
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { quadsForSelection, quadToRect, hexToRgb, round2 } from '../geometry.js';

const TYPES = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' };

export class MarkupTool {
  constructor(app, name) { this.app = app; this.name = name; this.drag = null; }
  activate() {}
  deactivate() { this.clear(); }
  clear() {
    if (this.drag) this.drag.v.toolLayer.querySelectorAll('.sel-quad').forEach((n) => n.remove());
    this.drag = null;
  }
  async onDown(v, pt, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    v.overlay.setPointerCapture(e.pointerId);
    this.drag = { v, start: pt, end: pt, quads: [], layout: null };
    const layout = await this.app.getLayout(v.index);
    if (this.drag?.v === v) this.drag.layout = layout;
  }
  onMove(v, pt) {
    const d = this.drag;
    if (!d || d.v !== v || !d.layout) return;
    d.end = pt;
    const { quads } = quadsForSelection(d.layout, d.start, d.end);
    d.quads = quads;
    v.toolLayer.querySelectorAll('.sel-quad').forEach((n) => n.remove());
    for (const q of quads) {
      const el = placeEl(document.createElement('div'), quadToRect(q));
      el.className += ' sel-quad';
      v.toolLayer.appendChild(el);
    }
  }
  async onUp(v, pt) {
    const d = this.drag;
    if (!d) return;
    if (d.layout && pt) this.onMove(d.v, pt);
    const quads = d.quads;
    const moved = Math.hypot(d.end[0] - d.start[0], d.end[1] - d.start[1]) > 2;
    this.clear();
    if (!quads.length || !moved) return;
    const pr = state.toolProps[this.name];
    await this.app.mutate('addAnnotation', {
      page: d.v.index, type: TYPES[this.name], quads: quads.map((q) => q.map(round2)),
      color: hexToRgb(pr.color), opacity: Number(pr.opacity),
    }, null, { page: d.v.index });
  }
}
