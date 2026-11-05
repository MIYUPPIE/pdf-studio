// Select tool + selection box (move / resize / delete / nudge / inline edit).
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { moveRect, resizeRect, annotGeometryUpdate, hexToRgb, rgbToHex } from '../geometry.js';
import { hitTest, openTextEditor, FREE_FONTS, freeTextRect } from './common.js';
import { promptDialog } from '../dialogs.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const POINT_TYPES = new Set(['Ink', 'Line', 'PolyLine', 'Polygon', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

export class Selection {
  constructor(app) { this.app = app; this.box = null; this.annot = null; }

  get view() { return state.selected ? this.app.viewer.views[state.selected.page] : null; }

  async select(page, id) {
    this.clearBox();
    state.selected = { page, id };
    await this.draw();
    this.app.props.render();
  }

  deselect() {
    if (!state.selected) return;
    state.selected = null;
    this.annot = null;
    this.clearBox();
    this.app.props.render();
  }

  clearBox() {
    this.box?.remove();
    this.box = null;
  }

  /** Redraw the selection box from fresh engine data (after re-render / update). */
  async draw() {
    const sel = state.selected;
    if (!sel) return;
    const v = this.app.viewer.views[sel.page];
    if (!v) { this.deselect(); return; }
    const annots = await this.app.getAnnots(sel.page);
    if (state.selected !== sel) return;
    const a = annots.find((x) => x.id === sel.id);
    if (!a) { this.deselect(); return; }
    this.annot = a;
    this.clearBox();
    const box = document.createElement('div');
    box.className = 'sel-box movable';
    box.dataset.annotId = a.id;
    box.dataset.annotType = a.type;
    box.tabIndex = -1;
    placeEl(box, a.rect);
    if (a.type !== 'Text') for (const h of HANDLES) {
      const hd = document.createElement('div');
      hd.className = 'handle';
      hd.dataset.h = h;
      box.appendChild(hd);
    }
    box.addEventListener('pointerdown', (e) => this.startDrag(e, v, a, box));
    box.addEventListener('dblclick', (e) => { e.stopPropagation(); this.editContents(v, a); });
    v.selLayer.appendChild(box);
    this.box = box;
  }

  startDrag(e, v, a, box) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const handle = e.target.dataset?.h || null;
    const start = v.toPage(e);
    let rect = a.rect;
    let moved = false;
    box.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const p = v.toPage(ev);
      const dx = p[0] - start[0], dy = p[1] - start[1];
      if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
      rect = handle ? resizeRect(a.rect, handle, dx, dy) : moveRect(a.rect, dx, dy);
      if (ev.shiftKey && handle && handle.length === 2) {
        // keep aspect ratio on corner drag
        const ar = (a.rect[2] - a.rect[0]) / (a.rect[3] - a.rect[1]);
        const w = rect[2] - rect[0];
        const h = w / ar;
        if (handle.includes('n')) rect = [rect[0], rect[3] - h, rect[2], rect[3]]; else rect = [rect[0], rect[1], rect[2], rect[1] + h];
      }
      placeEl(box, rect);
    };
    const onUp = async () => {
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      if (!moved) return;
      await this.updateGeometry(v.index, a, rect);
    };
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  }

  async updateGeometry(page, a, rect) {
    const upd = POINT_TYPES.has(a.type) || a.ink || a.points || a.quads ? annotGeometryUpdate(a, rect) : { rect: rect.map((n) => Math.round(n * 100) / 100) };
    await this.app.mutate('updateAnnotation', { page, id: a.id, ...upd }, null, { page });
  }

  async nudge(dx, dy) {
    const a = this.annot;
    if (!a || !state.selected) return;
    await this.updateGeometry(state.selected.page, a, moveRect(a.rect, dx, dy));
  }

  async remove() {
    const sel = state.selected;
    if (!sel) return;
    this.deselect();
    await this.app.mutate('deleteAnnotation', { page: sel.page, id: sel.id }, null, { page: sel.page });
  }

  async update(spec) {
    const sel = state.selected;
    if (!sel) return;
    await this.app.mutate('updateAnnotation', { page: sel.page, id: sel.id, ...spec }, null, { page: sel.page });
  }

  editContents(v, a) {
    if (a.type === 'FreeText') {
      this.clearBox();
      const size = a.fontSize || 12;
      openTextEditor(v, {
        rect: a.rect, text: a.contents || '', fontSize: size, color: rgbToHex(a.color || [0, 0, 0]),
        font: { family: FREE_FONTS[a.font] || FREE_FONTS.Helv },
        onCommit: (text) => {
          if (text === (a.contents || '')) { this.draw(); return; }
          const r = freeTextRect([a.rect[0], a.rect[1]], text, size, a.font);
          r[2] = Math.max(r[2], a.rect[2]);
          this.app.mutate('updateAnnotation', { page: v.index, id: a.id, contents: text, rect: r }, null, { page: v.index });
        },
        onCancel: () => this.draw(),
      });
    } else if (a.type === 'Text' || a.type === 'Square' || a.type === 'Circle' || a.type === 'Stamp' || a.type === 'Ink') {
      promptDialog(a.type === 'Text' ? 'Edit note' : 'Comment', 'Text', a.contents || '', { multiline: true }).then((t) => {
        if (t !== null && t !== a.contents) this.update({ contents: t });
      });
    }
  }
}

export class SelectTool {
  constructor(app) { this.app = app; this.name = 'select'; }
  activate() {}
  deactivate() { this.app.selection.deselect(); }
  async onDown(v, pt, e) {
    if (e.button !== 0) return;
    const annots = await this.app.getAnnots(v.index);
    const hit = hitTest(annots, pt);
    if (hit) {
      await this.app.selection.select(v.index, hit.id);
      // allow immediate drag-after-select
      const box = this.app.selection.box;
      if (box && e.buttons === 1) this.app.selection.startDrag(e, v, this.app.selection.annot, box);
    } else {
      this.app.selection.deselect();
    }
  }
  onDblClick(v, pt) {
    const a = hitTest(v.annots, pt);
    if (a) this.app.selection.editContents(v, a);
  }
  onKey(e) {
    const sel = this.app.selection;
    if (!state.selected) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') { sel.remove(); return true; }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { sel.nudge(...d); return true; }
    if (e.key === 'Enter') { sel.editContents(sel.view, sel.annot); return true; }
    return false;
  }
}

export { hexToRgb };
