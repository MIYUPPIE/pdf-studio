// Right-hand properties panel: options for the active tool, or for the selected annotation.
import { state } from './state.js';
import { hexToRgb, rgbToHex } from './geometry.js';
import { escapeHtml } from './dialogs.js';

const TOOL_TITLES = {
  select: 'Select', edittext: 'Edit text', text: 'Add text', image: 'Image', draw: 'Draw', rect: 'Rectangle',
  ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', highlight: 'Highlight', underline: 'Underline', strike: 'Strikeout',
  note: 'Note', signature: 'Signature', form: 'Form fields', redact: 'Redact',
};
const HELP = {
  select: 'Click an annotation to select it. Drag to move, use the handles to resize, Delete to remove, arrow keys to nudge (Shift = 10pt). Double-click text boxes to edit.',
  edittext: 'Click any line of existing text to edit it. Enter saves, Shift+Enter adds a line, Esc cancels. The original font is reused when it contains every character you type.',
  text: 'Click anywhere on a page and start typing. Enter to finish, Shift+Enter for a new line.',
  image: 'Choose a PNG or JPEG, then click on a page to place it. Move and resize it with the Select tool.',
  draw: 'Drag on a page to draw freehand.',
  rect: 'Drag to draw. Hold Shift for a square.',
  ellipse: 'Drag to draw. Hold Shift for a circle.',
  line: 'Drag to draw. Hold Shift to snap to 45°.',
  arrow: 'Drag to draw. Hold Shift to snap to 45°.',
  highlight: 'Drag across text to highlight it.',
  underline: 'Drag across text to underline it.',
  strike: 'Drag across text to strike it out.',
  note: 'Click to add a sticky note comment.',
  signature: 'Click on a page to place your signature.',
  form: 'Fill: type into fields directly. Other modes: drag a rectangle to create a new field.',
  redact: 'Drag over content to mark it. Nothing is removed until you press "Apply redactions". Redaction is permanent in the downloaded file.',
};
const SWATCHES = ['#111111', '#e5484d', '#f59e0b', '#ffd400', '#22c55e', '#1d4ed8', '#7c3aed', '#ffffff'];

export class PropsPanel {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('props');
  }

  render() {
    if (!state.info) { this.el.innerHTML = ''; return; }
    const sel = state.selected && this.app.selection.annot;
    if (state.tool === 'select' && sel) this.renderAnnot(sel);
    else this.renderTool(state.tool);
  }

  // ----- controls
  colorRow(label, key, value, allowNone = false) {
    return `<div class="row"><label for="pp-${key}">${label}</label>
      <div class="swatches" data-swatches="${key}">${SWATCHES.map((c) => `<button type="button" class="swatch" style="background:${c}" data-color="${c}" aria-label="${c}" aria-pressed="${c === value}"></button>`).join('')}
      ${allowNone ? `<button type="button" class="swatch" data-color="" aria-label="No fill" aria-pressed="${!value}" style="background:linear-gradient(45deg,transparent 45%,red 45% 55%,transparent 55%),#fff"></button>` : ''}</div>
      <input type="color" id="pp-${key}" data-key="${key}" value="${value || '#ffffff'}"></div>`;
  }
  rangeRow(label, key, value, min, max, step, fmt = (v) => v) {
    return `<div class="row"><label for="pp-${key}">${label}: <span data-out="${key}">${fmt(value)}</span></label>
      <input type="range" id="pp-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;
  }
  numberRow(label, key, value, min, max) {
    return `<div class="row"><label for="pp-${key}">${label}</label><input type="number" id="pp-${key}" data-key="${key}" min="${min}" max="${max}" value="${value}"></div>`;
  }
  fontRow(key, value, includeOriginal = false) {
    const opts = [
      ...(includeOriginal ? [['original', 'Keep original font']] : []),
      ...(includeOriginal
        ? [['Helvetica', 'Helvetica (sans)'], ['Helvetica-Bold', 'Helvetica Bold'], ['Times-Roman', 'Times (serif)'], ['Times-Bold', 'Times Bold'], ['Courier', 'Courier (mono)']]
        : [['Helv', 'Helvetica (sans)'], ['TiRo', 'Times (serif)'], ['Cour', 'Courier (mono)']]),
      ...(includeOriginal ? state.fonts.map((f) => [f, f]) : []),
    ];
    return `<div class="row"><label for="pp-${key}">Font</label><select id="pp-${key}" data-key="${key}">${opts.map(([v, l]) => `<option value="${escapeHtml(v)}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>`;
  }

  renderTool(tool) {
    const p = state.toolProps[tool] || {};
    let html = `<h2>${TOOL_TITLES[tool]}</h2><p class="help">${HELP[tool] || ''}</p>`;
    switch (tool) {
      case 'edittext': html += this.fontRow('font', p.font, true); break;
      case 'text': html += this.colorRow('Text color', 'color', p.color) + this.numberRow('Font size', 'fontSize', p.fontSize, 4, 200) + this.fontRow('font', p.font); break;
      case 'draw': case 'line': case 'arrow':
        html += this.colorRow('Color', 'color', p.color) + this.rangeRow('Width', 'width', p.width, 0.5, 20, 0.5) + this.rangeRow('Opacity', 'opacity', p.opacity, 0.1, 1, 0.05, pct); break;
      case 'rect': case 'ellipse':
        html += this.colorRow('Stroke', 'color', p.color) + this.colorRow('Fill', 'fill', p.fill, true) + this.rangeRow('Width', 'width', p.width, 0, 20, 0.5) + this.rangeRow('Opacity', 'opacity', p.opacity, 0.1, 1, 0.05, pct); break;
      case 'highlight': case 'underline': case 'strike':
        html += this.colorRow('Color', 'color', p.color) + this.rangeRow('Opacity', 'opacity', p.opacity, 0.1, 1, 0.05, pct); break;
      case 'note': html += this.colorRow('Color', 'color', p.color); break;
      case 'signature':
        html += this.colorRow('Ink color', 'color', p.color) + this.rangeRow('Ink width', 'width', p.width, 0.5, 6, 0.5)
          + `<div class="actions"><button type="button" class="btn" data-act="newSig">${state.signature ? 'Change signature' : 'Create signature'}</button></div>`; break;
      case 'form': {
        const modes = [['fill', 'Fill'], ['text', 'Text'], ['checkbox', 'Checkbox'], ['combo', 'Dropdown'], ['list', 'List'], ['signature', 'Signature']];
        html += `<div class="row"><label>Mode</label><div class="seg" data-seg="mode">${modes.map(([v, l]) => `<button type="button" data-val="${v}" aria-pressed="${p.mode === v}">${l}</button>`).join('')}</div></div>`;
        if (!state.info.hasForms) html += '<p class="help">This document has no form fields yet. Pick a field type above and drag on a page to create one.</p>';
        break;
      }
      case 'redact': {
        const n = [...state.redactions.values()].reduce((a, l) => a + l.length, 0);
        html += this.colorRow('Fill color', 'fill', p.fill) + `<div class="actions"><button type="button" class="btn danger-solid" data-act="applyRedact" ${n ? '' : 'disabled'}>Apply ${n || ''} redaction${n === 1 ? '' : 's'}</button></div>`;
        break;
      }
      case 'image': html += '<div class="actions"><button type="button" class="btn" data-act="pickImage">Choose image…</button></div>'; break;
      default: break;
    }
    this.el.innerHTML = html;
    this.bind((key, val) => {
      p[key] = val;
      if (key === 'mode') this.render();
    });
    this.el.querySelector('[data-act=newSig]')?.addEventListener('click', () => this.app.tools.tools.signature.newSignature());
    this.el.querySelector('[data-act=applyRedact]')?.addEventListener('click', () => this.app.applyRedactions());
    this.el.querySelector('[data-act=pickImage]')?.addEventListener('click', () => this.app.tools.tools.image.choose());
  }

  renderAnnot(a) {
    const t = a.type;
    let html = `<h2>${escapeHtml(t === 'FreeText' ? 'Text box' : t === 'Text' ? 'Note' : t === 'Stamp' ? 'Image / stamp' : t)}</h2>`;
    const hasStroke = !['Stamp', 'Highlight', 'Text', 'FreeText'].includes(t);
    if (t !== 'Stamp') html += this.colorRow(t === 'FreeText' ? 'Text color' : 'Color', 'color', rgbToHex(a.color || [0, 0, 0]));
    if (t === 'Square' || t === 'Circle') html += this.colorRow('Fill', 'fill', a.fill ? rgbToHex(a.fill) : '', true);
    if (hasStroke && !['Underline', 'StrikeOut', 'Squiggly'].includes(t)) html += this.rangeRow('Width', 'borderWidth', a.borderWidth ?? 1, 0, 20, 0.5);
    html += this.rangeRow('Opacity', 'opacity', a.opacity ?? 1, 0.1, 1, 0.05, pct);
    if (t === 'FreeText') html += this.numberRow('Font size', 'fontSize', a.fontSize || 12, 4, 200) + this.fontRow('font', a.font || 'Helv');
    if (t === 'FreeText' || t === 'Text' || t === 'Square' || t === 'Circle' || t === 'Ink' || t === 'Highlight') {
      html += `<div class="row"><label for="pp-contents">${t === 'FreeText' ? 'Text' : 'Comment'}</label><textarea id="pp-contents" data-key="contents" rows="3">${escapeHtml(a.contents || '')}</textarea></div>`;
    }
    html += `<div class="actions"><button type="button" class="btn" data-act="delete">Delete</button></div>`;
    this.el.innerHTML = html;
    this.bind((key, val) => {
      let v = val;
      if (key === 'color' || key === 'fill') v = val ? hexToRgb(val) : null;
      if (['opacity', 'borderWidth', 'fontSize'].includes(key)) v = Number(val);
      this.app.selection.update({ [key]: v });
    }, true);
    this.el.querySelector('[data-act=delete]').addEventListener('click', () => this.app.selection.remove());
  }

  /** Wire inputs. `commitOnly`: only fire on change (not every input tick) to avoid flooding the journal. */
  bind(set, commitOnly = false) {
    for (const input of this.el.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      const out = this.el.querySelector(`[data-out="${key}"]`);
      const val = () => (input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value);
      input.addEventListener('input', () => {
        if (out) out.textContent = key === 'opacity' ? pct(input.value) : input.value;
        if (!commitOnly && input.tagName !== 'TEXTAREA') set(key, val());
      });
      input.addEventListener('change', () => {
        set(key, val());
        this.markSwatch(key, input.value);
      });
    }
    for (const group of this.el.querySelectorAll('[data-swatches]')) {
      const key = group.dataset.swatches;
      group.addEventListener('click', (e) => {
        const b = e.target.closest('[data-color]');
        if (!b) return;
        const c = b.dataset.color;
        const input = this.el.querySelector(`input[data-key="${key}"]`);
        if (input && c) input.value = c;
        this.markSwatch(key, c);
        set(key, c);
      });
    }
    for (const seg of this.el.querySelectorAll('[data-seg]')) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-val]');
        if (b) set(seg.dataset.seg, b.dataset.val);
      });
    }
  }

  markSwatch(key, color) {
    this.el.querySelectorAll(`[data-swatches="${key}"] [data-color]`).forEach((b) => b.setAttribute('aria-pressed', b.dataset.color.toLowerCase() === String(color).toLowerCase()));
  }
}

function pct(v) { return `${Math.round(Number(v) * 100)}%`; }
