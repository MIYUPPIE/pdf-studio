// Find in document: per-page engine search, highlighted hits, next/prev navigation.
import { state } from './state.js';
import { placeEl } from './viewer.js';
import { quadToRect } from './geometry.js';

export class Search {
  constructor(app) {
    this.app = app;
    this.bar = document.getElementById('searchBar');
    this.input = document.getElementById('searchInput');
    this.count = document.getElementById('searchCount');
    this.hits = []; // {page, rect}
    this.active = -1;
    this.query = '';
    this.token = 0;
    this.debounce = null;
    this.input.addEventListener('input', () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => { if (this.input.value !== this.query) this.run(this.input.value); }, 250);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Enter supersedes the pending as-you-type search (otherwise it fires
        // later and cancels this one, losing the jump to the first hit).
        clearTimeout(this.debounce);
        if (this.input.value !== this.query) this.run(this.input.value).then(() => this.step(1));
        else this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    document.getElementById('searchNext').addEventListener('click', () => this.step(1));
    document.getElementById('searchPrev').addEventListener('click', () => this.step(-1));
    document.getElementById('searchClose').addEventListener('click', () => this.close());
  }

  open() {
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
  }

  close() {
    this.bar.hidden = true;
    this.clear();
    this.query = '';
    this.input.value = '';
    document.getElementById('viewer').focus();
  }

  clear() {
    this.token++;
    this.hits = [];
    this.active = -1;
    this.count.textContent = '';
    for (const v of this.app.viewer.views) v.searchLayer.innerHTML = '';
  }

  async run(q) {
    this.clear();
    this.query = q;
    if (!q.trim() || !state.info) return;
    const token = this.token;
    const n = state.info.pageCount;
    this.count.textContent = 'Searching…';
    // search starting from the current page so the first hit is nearby
    for (let k = 0; k < n; k++) {
      const page = (state.currentPage + k) % n;
      let res;
      try {
        ({ result: res } = await this.app.client.call(state.docId, 'search', { page, needle: q }));
      } catch { continue; }
      if (token !== this.token) return;
      for (const hit of res.hits) {
        const rect = hit.map(quadToRect).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
        this.hits.push({ page, rect, quads: hit });
      }
      const v = this.app.viewer.views[page];
      if (v?.visible) this.renderPage(v);
    }
    this.hits.sort((a, b) => a.page - b.page || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
    this.updateCount();
    for (const v of this.app.viewer.views) if (v.visible) this.renderPage(v);
  }

  updateCount() {
    this.count.textContent = this.hits.length ? `${this.active + 1 > 0 ? this.active + 1 : 0} of ${this.hits.length}` : (this.query ? 'No matches' : '');
  }

  renderPage(v) {
    v.searchLayer.innerHTML = '';
    this.hits.forEach((h, i) => {
      if (h.page !== v.index) return;
      for (const q of h.quads) {
        const el = placeEl(document.createElement('div'), quadToRect(q));
        el.className += ' search-hit' + (i === this.active ? ' active' : '');
        v.searchLayer.appendChild(el);
      }
    });
  }

  step(dir) {
    if (!this.hits.length) return;
    if (this.active < 0) {
      // first hit at/after current page
      const idx = this.hits.findIndex((h) => h.page >= state.currentPage);
      this.active = dir > 0 ? (idx < 0 ? 0 : idx) : (idx <= 0 ? this.hits.length - 1 : idx - 1);
    } else {
      this.active = (this.active + dir + this.hits.length) % this.hits.length;
    }
    const h = this.hits[this.active];
    this.app.viewer.scrollToRect(h.page, h.rect);
    for (const v of this.app.viewer.views) if (v.visible || v.index === h.page) this.renderPage(v);
    this.updateCount();
  }
}
