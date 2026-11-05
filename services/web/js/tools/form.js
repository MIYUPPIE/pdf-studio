// Form tool: fill mode (inputs are live overlays rendered by the viewer) and create mode
// (drag a rectangle to add a text / checkbox / dropdown / signature field).
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { rectFromPoints, rectWidth, rectHeight, round2 } from '../geometry.js';
import { modal, escapeHtml } from '../dialogs.js';

const DEFAULT_SIZE = { text: [180, 22], checkbox: [14, 14], combo: [150, 22], list: [150, 60], radio: [14, 14], signature: [180, 50] };

export class FormTool {
  constructor(app) { this.app = app; this.name = 'form'; this.drag = null; }
  get mode() { return state.toolProps.form.mode || 'fill'; }
  activate() {}
  deactivate() { this.drag?.el.remove(); this.drag = null; }
  onDown(v, pt, e) {
    if (this.mode === 'fill' || e.button !== 0 || e.target.closest('.field')) return;
    e.preventDefault();
    v.overlay.setPointerCapture(e.pointerId);
    const el = document.createElement('div');
    el.className = 'preview-rect';
    v.toolLayer.appendChild(el);
    this.drag = { v, start: pt, end: pt, el };
    placeEl(el, rectFromPoints(pt, pt));
  }
  onMove(v, pt) {
    if (!this.drag || this.drag.v !== v) return;
    this.drag.end = pt;
    placeEl(this.drag.el, rectFromPoints(this.drag.start, pt));
  }
  async onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.el.remove();
    const type = this.mode;
    let rect = rectFromPoints(d.start, d.end);
    if (rectWidth(rect) < 4 || rectHeight(rect) < 4) {
      const [w, h] = DEFAULT_SIZE[type] || [150, 22];
      rect = [d.start[0], d.start[1], d.start[0] + w, d.start[1] + h];
    }
    const res = await modal({
      title: `New ${type === 'combo' ? 'dropdown' : type} field`,
      body: `<label class="f">Field name<input type="text" name="name" value="${escapeHtml(`${type}_${Date.now() % 100000}`)}" required></label>
        ${type === 'combo' || type === 'list' ? '<label class="f">Options (one per line)<textarea name="options" rows="4">Option 1\nOption 2\nOption 3</textarea></label>' : ''}
        ${type === 'text' ? '<label class="c"><input type="checkbox" name="multiline"> Multi-line</label>' : ''}`,
      ok: 'Add field',
      validate: (dt) => (dt.name.trim() ? '' : 'Name is required'),
    });
    if (!res) return;
    const args = { page: d.v.index, type, rect: rect.map(round2), name: res.name.trim() };
    if (res.options !== undefined) args.options = res.options.split('\n').map((s) => s.trim()).filter(Boolean);
    if (res.multiline) args.multiline = true;
    await this.app.mutate('addField', args, null, { page: d.v.index });
  }
}
