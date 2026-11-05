// Edit existing text: hover shows line boxes from textLayout, click opens an inline editor,
// commit calls replaceText with the line bbox.
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { lineAt, dominantSpan, rgbToHex } from '../geometry.js';
import { openTextEditor, spanFontCss, closeTextEditor } from './common.js';

export class EditTextTool {
  constructor(app) { this.app = app; this.name = 'edittext'; this.editing = false; }

  activate() {
    for (const v of this.app.viewer.views) if (v.visible) this.onPageVisible(v);
  }

  deactivate() {
    closeTextEditor(true);
    for (const v of this.app.viewer.views) v.toolLayer.querySelectorAll('.text-line').forEach((n) => n.remove());
  }

  async onPageVisible(v) {
    let layout;
    try { layout = await this.app.getLayout(v.index); } catch { return; }
    if (state.tool !== this.name || this.app.viewer.views[v.index] !== v) return;
    v.toolLayer.querySelectorAll('.text-line').forEach((n) => n.remove());
    for (const block of layout.blocks || []) {
      for (const line of block.lines || []) {
        if (!line.text?.trim()) continue;
        const d = placeEl(document.createElement('div'), line.bbox);
        d.className += ' text-line';
        d.dataset.lineId = line.id;
        d.title = 'Click to edit';
        v.toolLayer.appendChild(d);
      }
    }
  }

  async onDown(v, pt, e) {
    if (e.button !== 0 || this.editing) return;
    e.preventDefault();
    const layout = await this.app.getLayout(v.index);
    const line = lineAt(layout, pt, 2);
    if (!line) return;
    this.open(v, line);
  }

  open(v, line) {
    const span = dominantSpan(line) || {};
    const size = span.size || 12;
    this.editing = true;
    const lineEl = v.toolLayer.querySelector(`.text-line[data-line-id="${CSS.escape(line.id)}"]`);
    if (lineEl) lineEl.style.visibility = 'hidden';
    openTextEditor(v, {
      rect: line.bbox,
      text: line.text,
      fontSize: size,
      color: rgbToHex(span.color || [0, 0, 0]),
      font: spanFontCss(span),
      onCommit: async (text) => {
        this.editing = false;
        if (text === line.text) { if (lineEl) lineEl.style.visibility = ''; return; }
        const p = state.toolProps.edittext;
        await this.app.mutate('replaceText', {
          page: v.index, bbox: line.bbox, text, font: p.font || 'original',
        }, null, { page: v.index });
      },
      onCancel: () => { this.editing = false; if (lineEl) lineEl.style.visibility = ''; },
    });
  }

  onKey() { return false; }
}
