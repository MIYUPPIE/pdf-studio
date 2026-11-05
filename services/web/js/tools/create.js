// Tools that create new annotations: text box, image, freehand ink, shapes, sticky note.
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { hexToRgb, rectFromPoints, lineRect, simplifyStroke, imagePlacementRect, round2, rectWidth, rectHeight } from '../geometry.js';
import { openTextEditor, freeTextRect, FREE_FONTS, loadImage, pickFile, Ghost } from './common.js';
import { promptDialog, toast } from '../dialogs.js';

const p = (tool) => state.toolProps[tool];
const pts = (arr) => arr.map((pt) => pt.map(round2));

export class TextTool {
  constructor(app) { this.app = app; this.name = 'text'; }
  activate() {}
  deactivate() {}
  onDown(v, pt, e) {
    if (e.button !== 0 || e.target.closest('.text-editor')) return;
    e.preventDefault();
    const pr = p('text');
    const size = Number(pr.fontSize) || 14;
    const rect = [pt[0], pt[1] - size * 0.6, pt[0] + 120, pt[1] + size * 0.8];
    openTextEditor(v, {
      rect, text: '', fontSize: size, color: pr.color, font: { family: FREE_FONTS[pr.font] || FREE_FONTS.Helv },
      placeholder: 'Type here',
      onCommit: async (text) => {
        if (!text.trim()) return;
        const r = freeTextRect([rect[0], rect[1]], text, size, pr.font);
        await this.app.mutate('addAnnotation', {
          page: v.index, type: 'FreeText', rect: r, contents: text, color: hexToRgb(pr.color),
          font: pr.font || 'Helv', fontSize: size, align: 0,
        }, null, { page: v.index });
      },
    });
  }
}

export class ImageTool {
  constructor(app) { this.app = app; this.name = 'image'; this.img = null; this.ghost = null; }
  async activate() { await this.choose(); }
  deactivate() { this.ghost?.remove(); this.ghost = null; }
  async choose() {
    const file = await pickFile('imageInput');
    if (!file) return false;
    try {
      this.img = await loadImage(file);
    } catch (e) {
      toast(`Could not read image: ${e.message}`, 'error');
      return false;
    }
    const r = imagePlacementRect([0, 0], this.img.width, this.img.height);
    this.ghost?.remove();
    this.ghost = new Ghost(rectWidth(r), rectHeight(r), `<img alt="" src="${this.img.url}">`);
    toast('Click on a page to place the image');
    return true;
  }
  onMove(v, pt) { this.ghost?.move(v, pt); }
  onLeave() { this.ghost?.remove(); }
  async onDown(v, pt, e) {
    if (e.button !== 0) return;
    if (!this.img) { await this.choose(); return; }
    const rect = imagePlacementRect(pt, this.img.width, this.img.height);
    const img = this.img;
    this.img = null;
    this.ghost?.remove();
    this.ghost = null;
    const res = await this.app.mutate('addAnnotation', { page: v.index, type: 'Stamp', rect, image: true }, img.bytes, { page: v.index });
    if (res) {
      this.app.tools.set('select');
      await this.app.selection.select(v.index, res.id);
    }
  }
}

export class DrawTool {
  constructor(app) { this.app = app; this.name = 'draw'; this.stroke = null; }
  activate() {}
  deactivate() { this.stroke?.path.remove(); this.stroke = null; }
  onDown(v, pt, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    v.overlay.setPointerCapture(e.pointerId);
    const pr = p('draw');
    const path = v.svgEl('polyline', {
      fill: 'none', stroke: pr.color, 'stroke-width': pr.width, 'stroke-opacity': pr.opacity,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', points: `${pt[0]},${pt[1]}`,
    });
    this.stroke = { v, points: [pt], path };
  }
  onMove(v, pt) {
    const s = this.stroke;
    if (!s || s.v !== v) return;
    s.points.push(pt);
    s.path.setAttribute('points', s.points.map((q) => q.join(',')).join(' '));
  }
  async onUp(v) {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    let points = simplifyStroke(s.points);
    if (points.length === 1) points = [points[0], [points[0][0] + 0.5, points[0][1] + 0.5]];
    const pr = p('draw');
    const res = await this.app.mutate('addAnnotation', {
      page: s.v.index, type: 'Ink', ink: [pts(points)], color: hexToRgb(pr.color),
      borderWidth: Number(pr.width), opacity: Number(pr.opacity),
    }, null, { page: s.v.index });
    if (!res) s.path.remove();
    else setTimeout(() => s.path.remove(), 400); // keep preview until the re-render lands
  }
}

export class ShapeTool {
  constructor(app, name) { this.app = app; this.name = name; this.drag = null; }
  activate() {}
  deactivate() { this.drag?.el.remove(); this.drag = null; }
  onDown(v, pt, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    v.overlay.setPointerCapture(e.pointerId);
    const pr = p(this.name);
    const common = { stroke: pr.color, 'stroke-width': pr.width, 'stroke-opacity': pr.opacity, fill: pr.fill || 'none' };
    let el;
    if (this.name === 'rect') el = v.svgEl('rect', { ...common, x: pt[0], y: pt[1], width: 0, height: 0 });
    else if (this.name === 'ellipse') el = v.svgEl('ellipse', { ...common, cx: pt[0], cy: pt[1], rx: 0, ry: 0 });
    else el = v.svgEl('line', { ...common, x1: pt[0], y1: pt[1], x2: pt[0], y2: pt[1], 'stroke-linecap': 'round' });
    this.drag = { v, start: pt, end: pt, el };
  }
  onMove(v, pt, e) {
    const d = this.drag;
    if (!d || d.v !== v) return;
    let end = pt;
    if (e.shiftKey) {
      const dx = pt[0] - d.start[0], dy = pt[1] - d.start[1];
      if (this.name === 'line' || this.name === 'arrow') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        end = [d.start[0] + len * Math.cos(ang), d.start[1] + len * Math.sin(ang)];
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        end = [d.start[0] + Math.sign(dx || 1) * m, d.start[1] + Math.sign(dy || 1) * m];
      }
    }
    d.end = end;
    const r = rectFromPoints(d.start, end);
    if (this.name === 'rect') { d.el.setAttribute('x', r[0]); d.el.setAttribute('y', r[1]); d.el.setAttribute('width', r[2] - r[0]); d.el.setAttribute('height', r[3] - r[1]); }
    else if (this.name === 'ellipse') { d.el.setAttribute('cx', (r[0] + r[2]) / 2); d.el.setAttribute('cy', (r[1] + r[3]) / 2); d.el.setAttribute('rx', (r[2] - r[0]) / 2); d.el.setAttribute('ry', (r[3] - r[1]) / 2); }
    else { d.el.setAttribute('x2', end[0]); d.el.setAttribute('y2', end[1]); }
  }
  async onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const pr = p(this.name);
    const base = { color: hexToRgb(pr.color), borderWidth: Number(pr.width), opacity: Number(pr.opacity) };
    let spec;
    const len = Math.hypot(d.end[0] - d.start[0], d.end[1] - d.start[1]);
    if (this.name === 'rect' || this.name === 'ellipse') {
      let r = rectFromPoints(d.start, d.end);
      if (rectWidth(r) < 3 && rectHeight(r) < 3) r = [d.start[0], d.start[1], d.start[0] + 100, d.start[1] + 60];
      spec = { type: this.name === 'rect' ? 'Square' : 'Circle', rect: r.map(round2), fill: pr.fill ? hexToRgb(pr.fill) : null, ...base };
    } else {
      const end = len < 3 ? [d.start[0] + 100, d.start[1]] : d.end;
      spec = {
        type: 'Line', points: pts([d.start, end]), rect: lineRect(d.start, end, pr.width).map(round2),
        lineEnding: ['None', this.name === 'arrow' ? 'OpenArrow' : 'None'], ...base,
      };
    }
    const res = await this.app.mutate('addAnnotation', { page: d.v.index, ...spec }, null, { page: d.v.index });
    if (!res) d.el.remove(); else setTimeout(() => d.el.remove(), 400);
  }
}

export class NoteTool {
  constructor(app) { this.app = app; this.name = 'note'; }
  activate() {}
  deactivate() {}
  async onDown(v, pt, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const text = await promptDialog('Add note', 'Note text', '', { multiline: true, ok: 'Add note' });
    if (text === null) return;
    await this.app.mutate('addAnnotation', {
      page: v.index, type: 'Text', rect: [pt[0], pt[1], pt[0] + 20, pt[1] + 20].map(round2),
      contents: text, color: hexToRgb(p('note').color), author: this.app.author(),
    }, null, { page: v.index });
  }
}

export { placeEl };
