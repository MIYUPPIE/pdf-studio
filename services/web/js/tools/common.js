// Helpers shared by tools.
import { state } from '../state.js';
import { placeEl } from '../viewer.js';
import { rectContains, rectWidth, rectHeight, round2 } from '../geometry.js';

let mctx = null;
export function measureLines(text, size, family = 'Helvetica, Arial, sans-serif') {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `${size}px ${family}`;
  const lines = String(text).split('\n');
  const width = Math.max(...lines.map((l) => mctx.measureText(l).width), size);
  return { width, height: lines.length * size * 1.2, lines: lines.length };
}

export const FREE_FONTS = {
  Helv: 'Helvetica, Arial, sans-serif',
  TiRo: '"Times New Roman", Times, serif',
  Cour: '"Courier New", Courier, monospace',
};

/** Rect needed for a FreeText annotation holding `text` at top-left `pt`. */
export function freeTextRect(pt, text, size, font = 'Helv') {
  const m = measureLines(text || ' ', size, FREE_FONTS[font] || FREE_FONTS.Helv);
  return [pt[0], pt[1], pt[0] + m.width + 8, pt[1] + m.height + 6].map(round2);
}

export function spanFontCss(span) {
  if (!span) return { family: FREE_FONTS.Helv, weight: 'normal', style: 'normal' };
  const family = span.mono ? FREE_FONTS.Cour : span.serif ? FREE_FONTS.TiRo : FREE_FONTS.Helv;
  return { family, weight: span.bold ? 'bold' : 'normal', style: span.italic ? 'italic' : 'normal' };
}

/** Pick the annotation under pt: smallest-area hit wins so nested shapes stay reachable. */
export function hitTest(annots, pt, pad = 3) {
  let best = null, bestArea = Infinity;
  for (const a of annots || []) {
    if (!a.rect || !rectContains(a.rect, pt, pad)) continue;
    const area = rectWidth(a.rect) * rectHeight(a.rect);
    if (area <= bestArea) { best = a; bestArea = area; }
  }
  return best;
}

/**
 * Inline text editor (textarea) positioned in page space on a page view.
 * Enter commits (Shift+Enter = newline unless singleLine), Escape cancels, blur commits.
 */
export function openTextEditor(view, { rect, text = '', fontSize = 12, color = '#000', font = {}, placeholder = '', singleLine = false, onCommit, onCancel }) {
  closeTextEditor();
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = text;
  ta.placeholder = placeholder;
  ta.spellcheck = true;
  ta.setAttribute('aria-label', 'Edit text');
  placeEl(ta, rect);
  ta.style.removeProperty('--h');
  ta.style.height = 'auto';
  ta.style.setProperty('--fs', fontSize);
  ta.style.minWidth = `calc(${Math.max(20, rectWidth(rect))} * var(--s) * 1px)`;
  ta.style.width = 'auto';
  ta.style.color = color;
  ta.style.fontFamily = font.family || FREE_FONTS.Helv;
  ta.style.fontWeight = font.weight || 'normal';
  ta.style.fontStyle = font.style || 'normal';
  const autosize = () => {
    ta.rows = Math.max(1, ta.value.split('\n').length);
    ta.style.width = '0px';
    ta.style.width = `${ta.scrollWidth + 6}px`;
  };
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    ta.remove();
    current = null;
    if (commit) onCommit?.(ta.value); else onCancel?.();
  };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && (singleLine || !e.shiftKey) && !e.isComposing) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  view.toolLayer.appendChild(ta);
  autosize();
  ta.focus();
  ta.select();
  current = { ta, finish };
  return current;
}

let current = null;
export function closeTextEditor(commit = true) {
  if (current) current.finish(commit);
}
export function isEditingText() { return !!current; }

/** Load an image file -> {bytes (PNG/JPEG), width, height, url}. Converts other formats to PNG. */
export async function loadImage(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let blob = new Blob([bytes], { type: file.type });
  const bmp = await createImageBitmap(blob);
  const width = bmp.width, height = bmp.height;
  if (!/^image\/(png|jpeg)$/.test(file.type)) {
    const c = new OffscreenCanvas(width, height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    blob = await c.convertToBlob({ type: 'image/png' });
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  bmp.close?.();
  return { bytes, width, height, url: URL.createObjectURL(blob) };
}

/** Ask the user for an image file via the shared hidden input. Resolves null on cancel. */
export function pickFile(inputId) {
  const input = document.getElementById(inputId);
  return new Promise((resolve) => {
    input.value = '';
    const onChange = () => { cleanup(); resolve(input.files[0] || null); };
    const onCancel = () => { cleanup(); resolve(null); };
    const cleanup = () => { input.removeEventListener('change', onChange); input.removeEventListener('cancel', onCancel); };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

/** A ghost element that follows the pointer over pages until placed. */
export class Ghost {
  constructor(w, h, html = '') { this.w = w; this.h = h; this.html = html; this.el = null; this.view = null; }
  move(view, pt) {
    if (this.view !== view) {
      this.el?.remove();
      this.el = document.createElement('div');
      this.el.className = 'ghost-place';
      this.el.innerHTML = this.html;
      view.toolLayer.appendChild(this.el);
      this.view = view;
    }
    placeEl(this.el, this.rectAt(pt));
  }
  rectAt(pt) { return [pt[0] - this.w / 2, pt[1] - this.h / 2, pt[0] + this.w / 2, pt[1] + this.h / 2].map(round2); }
  remove() { this.el?.remove(); this.el = null; this.view = null; }
}

export function toolProps() { return state.toolProps[state.tool]; }
