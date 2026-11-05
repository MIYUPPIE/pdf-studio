// Sidebar page thumbnails: lazy render, multi-select, drag to reorder, context menu.
import { state, on } from './state.js';
import { computeReorder, isIdentityOrder } from './geometry.js';
import { contextMenu } from './dialogs.js';
import { icon } from './icons.js';

const THUMB_W = 120;

export class Thumbnails {
  constructor(app) {
    this.app = app;
    this.list = document.getElementById('thumbs');
    this.items = [];
    this.anchor = 0;
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderThumb(e.target.__idx);
    }, { root: document.getElementById('sidebar'), rootMargin: '300px 0px' });
    on('current-page', (i) => this.markCurrent(i));
    this.list.addEventListener('dragover', (e) => this.onDragOver(e));
    this.list.addEventListener('drop', (e) => this.onDrop(e));
    this.list.addEventListener('dragleave', (e) => { if (!this.list.contains(e.relatedTarget)) this.clearDropMarks(); });
    document.getElementById('thumbRotateL').addEventListener('click', () => this.app.rotatePages(this.targetPages(), -90));
    document.getElementById('thumbRotateR').addEventListener('click', () => this.app.rotatePages(this.targetPages(), 90));
    document.getElementById('thumbDelete').addEventListener('click', () => this.app.deletePages(this.targetPages()));
    document.getElementById('thumbExtract').addEventListener('click', () => this.app.docops.extract(this.targetPages()));
  }

  /** Pages acted on by sidebar buttons: multi-selection, else current page. */
  targetPages() {
    return state.selectedPages.size ? [...state.selectedPages].sort((a, b) => a - b) : [state.currentPage];
  }

  clear() {
    for (const it of this.items) this.io.unobserve(it.li);
    this.items = [];
    this.list.innerHTML = '';
  }

  build(info) {
    this.clear();
    state.selectedPages = new Set([...state.selectedPages].filter((i) => i < info.pages.length));
    info.pages.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'thumb';
      li.draggable = true;
      li.tabIndex = 0;
      li.dataset.page = i;
      li.__idx = i;
      li.setAttribute('aria-label', `Page ${i + 1}`);
      const h = Math.round((THUMB_W * p.height) / p.width);
      li.innerHTML = `<canvas width="${THUMB_W}" height="${h}" style="height:${h}px"></canvas><span class="num">${i + 1}</span>`;
      li.addEventListener('click', (e) => this.onClick(e, i));
      li.addEventListener('keydown', (e) => this.onKey(e, i));
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); this.openMenu(e.clientX, e.clientY, i); });
      li.addEventListener('dragstart', (e) => this.onDragStart(e, i));
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); this.clearDropMarks(); });
      this.list.appendChild(li);
      const item = { li, canvas: li.querySelector('canvas'), dirty: true, rendering: false, page: p };
      this.items.push(item);
      this.io.observe(li);
    });
    this.markSelection();
    this.markCurrent(state.currentPage);
  }

  invalidate(i) {
    const it = this.items[i];
    if (!it) return;
    it.dirty = true;
    const r = it.li.getBoundingClientRect();
    const sb = document.getElementById('sidebar').getBoundingClientRect();
    if (r.bottom > sb.top - 300 && r.top < sb.bottom + 300) this.renderThumb(i);
  }

  async renderThumb(i) {
    const it = this.items[i];
    if (!it || !it.dirty || it.rendering) return;
    it.rendering = true;
    it.dirty = false;
    const docId = state.docId;
    try {
      const dpr = window.devicePixelRatio || 1;
      const scale = (THUMB_W * dpr) / it.page.width;
      const { result, bytes } = await this.app.client.call(docId, 'render', { page: i, scale, annots: true, widgets: true });
      if (docId !== state.docId || this.items[i] !== it) return;
      it.canvas.width = result.width;
      it.canvas.height = result.height;
      it.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, result.width * result.height * 4), result.width, result.height), 0, 0);
      it.li.dataset.rendered = '1';
    } catch {
      it.dirty = true;
    } finally {
      it.rendering = false;
      if (it.dirty && this.items[i] === it) setTimeout(() => this.renderThumb(i), 50);
    }
  }

  markCurrent(i) {
    for (const it of this.items) it.li.classList.toggle('current', it.li.__idx === i);
    const cur = this.items[i]?.li;
    if (cur) {
      const sb = document.getElementById('sidebar');
      const r = cur.getBoundingClientRect(), s = sb.getBoundingClientRect();
      if (r.top < s.top + 40 || r.bottom > s.bottom) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  markSelection() {
    for (const it of this.items) {
      const sel = state.selectedPages.has(it.li.__idx);
      it.li.classList.toggle('selected', sel);
      it.li.setAttribute('aria-selected', sel);
    }
  }

  onClick(e, i) {
    if (e.shiftKey) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      for (let k = a; k <= b; k++) state.selectedPages.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selectedPages.has(i)) state.selectedPages.delete(i); else state.selectedPages.add(i);
      this.anchor = i;
    } else {
      state.selectedPages = new Set();
      this.anchor = i;
      this.app.viewer.scrollToPage(i);
    }
    this.markSelection();
  }

  onKey(e, i) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onClick(e, i); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.items[i + 1]?.li.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.items[i - 1]?.li.focus(); }
    else if (e.key === 'Delete') { e.preventDefault(); this.app.deletePages(state.selectedPages.size ? this.targetPages() : [i]); }
  }

  openMenu(x, y, i) {
    const pages = state.selectedPages.has(i) ? this.targetPages() : [i];
    const n = pages.length;
    const label = n > 1 ? `${n} pages` : `page ${i + 1}`;
    contextMenu(x, y, [
      { label: `Rotate right (${label})`, icon: 'rotate', action: () => this.app.rotatePages(pages, 90) },
      { label: `Rotate left (${label})`, icon: 'rotateleft', action: () => this.app.rotatePages(pages, -90) },
      { label: 'Insert blank page after', icon: 'plus', action: () => this.app.insertBlank(i + 1) },
      { label: `Duplicate ${label}`, icon: 'copy', action: () => this.app.duplicatePages(pages) },
      { label: `Extract ${label}…`, icon: 'extract', action: () => this.app.docops.extract(pages) },
      '-',
      { label: `Delete ${label}`, icon: 'trash', action: () => this.app.deletePages(pages), disabled: n >= this.items.length },
    ], icon);
  }

  // ---------- drag reorder ----------
  onDragStart(e, i) {
    this.dragPages = state.selectedPages.has(i) ? this.targetPages() : [i];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-pdf-pages', JSON.stringify(this.dragPages));
    e.dataTransfer.setData('text/plain', `pages ${this.dragPages.map((p) => p + 1).join(',')}`);
    this.items[i].li.classList.add('dragging');
  }

  dropTarget(e) {
    const li = e.target.closest?.('.thumb');
    if (!li) return { li: null, target: this.items.length };
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    return { li, after, target: li.__idx + (after ? 1 : 0) };
  }

  clearDropMarks() {
    for (const it of this.items) it.li.classList.remove('drop-before', 'drop-after');
  }

  onDragOver(e) {
    if (!this.dragPages) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const { li, after } = this.dropTarget(e);
    this.clearDropMarks();
    if (li) li.classList.add(after ? 'drop-after' : 'drop-before');
  }

  async onDrop(e) {
    if (!this.dragPages) return;
    e.preventDefault();
    const { target } = this.dropTarget(e);
    const moving = this.dragPages;
    this.dragPages = null;
    this.clearDropMarks();
    const order = computeReorder(this.items.length, moving, target);
    if (isIdentityOrder(order)) return;
    await this.app.reorderPages(order);
  }
}
