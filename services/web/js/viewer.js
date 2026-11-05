// Continuous-scroll page viewer: lazy HiDPI rendering, per-page overlays, field widgets.
import { state, emit } from './state.js';
import { escapeHtml } from './dialogs.js';

const MAX_PIXELS = 16_000_000; // cap per-page bitmap (~64 MB RGBA)
const SVG_NS = 'http://www.w3.org/2000/svg';

export function placeEl(el, rect) {
  el.classList.add('pos');
  el.style.setProperty('--x', rect[0]);
  el.style.setProperty('--y', rect[1]);
  el.style.setProperty('--w', Math.max(0, rect[2] - rect[0]));
  el.style.setProperty('--h', Math.max(0, rect[3] - rect[1]));
  return el;
}

export class PageView {
  constructor(viewer, index, pinfo) {
    this.viewer = viewer;
    this.index = index;
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.innerHTML = `<div class="ph">Loading…</div><canvas class="pg" aria-hidden="true"></canvas>
      <div class="overlay">
        <svg class="draw-layer" xmlns="${SVG_NS}" preserveAspectRatio="none"></svg>
        <div class="layer passive search-layer"></div>
        <div class="layer tool-layer"></div>
        <div class="layer fields-layer"></div>
        <div class="layer sel-layer"></div>
      </div>`;
    this.canvas = this.el.querySelector('canvas');
    this.placeholder = this.el.querySelector('.ph');
    this.overlay = this.el.querySelector('.overlay');
    this.svg = this.el.querySelector('svg');
    this.toolLayer = this.el.querySelector('.tool-layer');
    this.fieldsLayer = this.el.querySelector('.fields-layer');
    this.selLayer = this.el.querySelector('.sel-layer');
    this.searchLayer = this.el.querySelector('.search-layer');
    this.visible = false;
    this.renderedScale = 0;
    this.dirty = true;
    this.annots = null;
    this.fields = null;
    this.layout = null;
    this.setInfo(pinfo, index);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'pointerleave']) {
      this.overlay.addEventListener(type, (e) => viewer.app.tools.dispatch(type, this, e));
    }
  }

  setInfo(pinfo, index) {
    this.index = index;
    this.width = pinfo.width;
    this.height = pinfo.height;
    this.rotation = pinfo.rotation;
    this.el.dataset.page = index;
    this.el.setAttribute('aria-label', `Page ${index + 1}`);
    this.el.style.setProperty('--pw', pinfo.width);
    this.el.style.setProperty('--ph', pinfo.height);
    this.svg.setAttribute('viewBox', `0 0 ${pinfo.width} ${pinfo.height}`);
  }

  invalidate() {
    this.dirty = true;
    this.annots = null;
    this.fields = null;
    this.layout = null;
  }

  /** Page-space point for a pointer event. */
  toPage(e) {
    const r = this.overlay.getBoundingClientRect();
    return [(e.clientX - r.left) / state.scale, (e.clientY - r.top) / state.scale];
  }

  svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    this.svg.appendChild(el);
    return el;
  }
}

export class Viewer {
  constructor(app) {
    this.app = app;
    this.scroller = document.getElementById('viewer');
    this.pagesEl = document.getElementById('pages');
    this.views = [];
    this.queue = new Set();
    this.rendering = false;
    this.renderGen = 0;
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target.__view;
        if (!v) continue;
        v.visible = e.isIntersecting;
        if (v.visible) this.onVisible(v);
      }
    }, { root: this.scroller, rootMargin: '800px 0px' });
    let ticking = false;
    this.scroller.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; this.updateCurrentPage(); });
    });
    // Ctrl+wheel zoom
    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !state.info) return;
      e.preventDefault();
      this.app.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    window.addEventListener('resize', () => {
      if (state.fitMode && state.info) this.app.applyFit();
    });
  }

  clear() {
    for (const v of this.views) this.io.unobserve(v.el);
    this.views = [];
    this.pagesEl.innerHTML = '';
    this.queue.clear();
  }

  /** (Re)build the page list from DocInfo, reusing existing elements to avoid flicker. */
  build(info) {
    const n = info.pages.length;
    while (this.views.length > n) {
      const v = this.views.pop();
      this.io.unobserve(v.el);
      v.el.remove();
    }
    for (let i = 0; i < n; i++) {
      let v = this.views[i];
      if (v) {
        v.setInfo(info.pages[i], i);
        v.invalidate();
      } else {
        v = new PageView(this, i, info.pages[i]);
        v.el.__view = v;
        this.views.push(v);
        this.pagesEl.appendChild(v.el);
        this.io.observe(v.el);
      }
    }
    for (const v of this.views) {
      v.selLayer.innerHTML = '';
      v.toolLayer.innerHTML = '';
      v.searchLayer.innerHTML = '';
      v.svg.innerHTML = '';
      if (v.visible) this.onVisible(v);
    }
    this.updateCurrentPage();
  }

  onVisible(v) {
    this.schedule(v);
    if (!v.fields) this.renderFields(v);
    this.app.tools.current?.onPageVisible?.(v);
    this.app.search?.renderPage(v);
    this.app.renderRedactions?.(v);
  }

  targetScale(v) {
    const dpr = window.devicePixelRatio || 1;
    let s = state.scale * dpr;
    const px = v.width * v.height * s * s;
    if (px > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / (v.width * v.height));
    return Math.round(s * 1000) / 1000;
  }

  schedule(v) {
    if (!v.dirty && v.renderedScale === this.targetScale(v)) return;
    this.queue.add(v);
    this.pump();
  }

  async pump() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.queue.size) {
        // Visible pages first, nearest to current page first.
        const list = [...this.queue].filter((v) => this.views[v.index] === v);
        this.queue.clear();
        list.sort((a, b) => (b.visible - a.visible) || Math.abs(a.index - state.currentPage) - Math.abs(b.index - state.currentPage));
        const [first, ...rest] = list;
        rest.forEach((v) => this.queue.add(v));
        if (!first || !first.visible) continue;
        await this.renderView(first);
      }
    } finally {
      this.rendering = false;
    }
  }

  async renderView(v) {
    const s = this.targetScale(v);
    if (!v.dirty && v.renderedScale === s) return;
    const docId = state.docId;
    const gen = this.renderGen;
    v.dirty = false;
    try {
      const { result, bytes } = await this.app.client.call(docId, 'render', { page: v.index, scale: s, annots: true, widgets: false });
      if (docId !== state.docId || gen !== this.renderGen || this.views[v.index] !== v) return;
      if (v.dirty) { this.queue.add(v); return; } // changed while rendering
      const { width, height } = result;
      v.canvas.width = width;
      v.canvas.height = height;
      const ctx = v.canvas.getContext('2d');
      ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, width * height * 4), width, height), 0, 0);
      v.renderedScale = s;
      v.placeholder.hidden = true;
      v.el.dataset.rendered = '1';
      emit('page-rendered', v.index);
      // Keep the annotation list warm so tools can hit-test existing objects
      // synchronously (pressing on an object selects it instead of creating).
      if (!v.annots) this.app.getAnnots(v.index).catch(() => {});
    } catch (e) {
      v.dirty = true;
      v.placeholder.textContent = 'Failed to render page';
      v.placeholder.hidden = false;
      if (e.code !== 'no_document') this.app.reportError(e);
    }
  }

  /** Re-render one page and refresh its overlays. */
  invalidatePage(i) {
    const v = this.views[i];
    if (!v) return;
    v.invalidate();
    if (v.visible) this.onVisible(v);
  }

  invalidateAll() {
    this.renderGen++;
    for (const v of this.views) this.invalidatePage(v.index);
  }

  /** Called after zoom: keep the current page anchored. */
  rescale(newScale) {
    const v = this.views[state.currentPage];
    let frac = 0;
    if (v) frac = (this.scroller.scrollTop - v.el.offsetTop) / Math.max(1, v.el.offsetHeight);
    const cx = this.scroller.scrollLeft + this.scroller.clientWidth / 2;
    const fx = cx / Math.max(1, this.scroller.scrollWidth);
    state.scale = newScale;
    document.documentElement.style.setProperty('--s', newScale);
    if (v) this.scroller.scrollTop = v.el.offsetTop + frac * v.el.offsetHeight;
    this.scroller.scrollLeft = fx * this.scroller.scrollWidth - this.scroller.clientWidth / 2;
    for (const view of this.views) if (view.visible) this.schedule(view);
  }

  updateCurrentPage() {
    if (!this.views.length) return;
    const top = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
    let cur = 0;
    for (const v of this.views) {
      if (v.el.offsetTop <= top) cur = v.index; else break;
    }
    if (cur !== state.currentPage) {
      state.currentPage = cur;
      emit('current-page', cur);
    }
  }

  scrollToPage(i, offsetPt = 0) {
    const v = this.views[i];
    if (!v) return;
    this.scroller.scrollTop = v.el.offsetTop - 16 + offsetPt * state.scale;
    state.currentPage = i;
    emit('current-page', i);
  }

  scrollToRect(i, rect) {
    const v = this.views[i];
    if (!v) return;
    const y = v.el.offsetTop + rect[1] * state.scale;
    const x = v.el.offsetLeft + rect[0] * state.scale;
    const sc = this.scroller;
    if (y < sc.scrollTop + 40 || y > sc.scrollTop + sc.clientHeight - 60) sc.scrollTop = y - sc.clientHeight / 3;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth / 3;
  }

  // ---------- form field overlays ----------
  async renderFields(v) {
    let fields;
    try {
      fields = await this.app.getFields(v.index);
    } catch {
      return;
    }
    if (this.views[v.index] !== v) return;
    v.fieldsLayer.innerHTML = '';
    for (const f of fields) v.fieldsLayer.appendChild(this.fieldElement(v, f));
  }

  fieldElement(v, f) {
    const wrap = placeEl(document.createElement('div'), f.rect);
    wrap.className += ' field';
    wrap.dataset.fieldId = f.id;
    wrap.dataset.fieldName = f.name;
    wrap.style.setProperty('--fh', Math.min(f.rect[3] - f.rect[1], 24));
    const label = `${f.name || 'Field'}`;
    const commit = (value) => this.app.mutate('setFieldValue', { page: v.index, id: f.id, value }, null, { page: v.index, rerender: false });
    let input;
    switch (f.type) {
      case 'checkbox':
      case 'radio':
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!f.checked;
        input.addEventListener('change', () => { f.checked = input.checked; commit(input.checked); });
        break;
      case 'combo':
      case 'list':
        input = document.createElement('select');
        if (f.type === 'list') input.size = Math.max(2, Math.min(5, f.options.length));
        input.innerHTML = f.options.map((o) => `<option${o === f.value ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
        if (!f.options.includes(f.value) && f.type === 'combo') input.insertAdjacentHTML('afterbegin', `<option selected value="${escapeHtml(f.value)}">${escapeHtml(f.value)}</option>`);
        input.addEventListener('change', () => { f.value = input.value; commit(input.value); });
        break;
      case 'signature':
        wrap.classList.add('sig');
        wrap.textContent = 'Sign here';
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('aria-label', `Signature field ${label}`);
        wrap.addEventListener('click', () => this.app.tools.signIntoRect(v.index, f.rect));
        break;
      case 'button':
        wrap.style.pointerEvents = 'none';
        break;
      default:
        input = document.createElement(f.multiline ? 'textarea' : 'input');
        if (!f.multiline) input.type = 'text';
        input.value = f.value || '';
        input.addEventListener('change', () => { f.value = input.value; commit(input.value); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !f.multiline) input.blur(); });
    }
    if (input) {
      input.setAttribute('aria-label', label);
      input.title = label;
      input.disabled = !!f.readOnly;
      wrap.appendChild(input);
    }
    // Delete button for form-editing mode
    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete field ${label}`);
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.mutate('deleteField', { page: v.index, id: f.id }, null, { page: v.index });
    });
    wrap.appendChild(del);
    wrap.addEventListener('pointerdown', (e) => {
      if (state.tool === 'select' || (state.tool === 'form' && state.toolProps.form.mode === 'fill')) e.stopPropagation();
    });
    return wrap;
  }
}
