// App bootstrap: wires engine client, viewer, thumbnails, tools, panels, menus and shortcuts.
import { EngineClient } from './engine-client.js';
import { state, on, emit } from './state.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { ToolManager, TOOL_KEYS } from './tools/index.js';
import { Selection } from './tools/select.js';
import { PropsPanel } from './props.js';
import { Search } from './search.js';
import { DocOps } from './docops.js';
import { renderRedactions, applyRedactions } from './tools/redact.js';
import { closeTextEditor, isEditingText } from './tools/common.js';
import { toast, busy, modal, confirmDialog, readFile, escapeHtml } from './dialogs.js';
import { hydrateIcons } from './icons.js';
import { fitScale, nextZoom, clampZoom } from './geometry.js';

const $ = (id) => document.getElementById(id);
const STRUCTURAL = new Set(['rotatePages', 'deletePages', 'reorderPages', 'insertBlankPage', 'insertDocument', 'undo', 'redo']);

const PAGE_SIZE_SELECT = `<select name="pageSize">
  <option value="A4" selected>A4 (210 × 297 mm)</option>
  <option value="Letter">Letter (8.5 × 11 in)</option>
  <option value="Legal">Legal (8.5 × 14 in)</option>
  <option value="A3">A3</option>
  <option value="A5">A5</option>
</select>`;

function pickFiles(inputId) {
  return new Promise((resolve) => {
    const input = document.getElementById(inputId);
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

class App {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.mock = params.get('mock') === '1';
    this.client = new EngineClient({ mock: this.mock });
    this.docCounter = 0;
    hydrateIcons();
    this.viewer = new Viewer(this);
    this.thumbs = new Thumbnails(this);
    this.selection = new Selection(this);
    this.props = new PropsPanel(this);
    this.tools = new ToolManager(this);
    this.search = new Search(this);
    this.docops = new DocOps(this);
    document.body.classList.add('no-doc');
    this.wire();
    this.loadFormats();
    on('current-page', (i) => { $('pageInput').value = i + 1; });
  }

  // ---------------- engine calls ----------------
  async call(method, args = {}, bytes = null) {
    busy(true);
    try {
      return await this.client.call(state.docId, method, args, bytes);
    } finally {
      busy(false);
    }
  }

  reportError(e) {
    console.error(e);
    if (e?.code === 'engine_load') toast('The PDF engine is not available. Build it with `make wasm`, or open with ?mock=1 for the demo engine.', 'error', 10000);
    else toast(e?.message || String(e), 'error');
  }

  /**
   * Run a mutating engine method, then refresh what changed.
   * opts.page: page to re-render; opts.rerender=false skips repaint (e.g. form values shown by live inputs).
   * Returns the result, or null when the engine reported an error (already toasted).
   */
  async mutate(method, args = {}, bytes = null, opts = {}) {
    if (STRUCTURAL.has(method)) {
      try { return await this.callStructural(method, args, bytes); } catch (e) { this.reportError(e); return null; }
    }
    let result;
    try {
      ({ result } = await this.call(method, args, bytes));
    } catch (e) {
      this.reportError(e);
      return null;
    }
    this.setDirty(true);
    const page = opts.page ?? args.page;
    if (opts.rerender !== false && page !== undefined) this.invalidatePage(page);
    else if (page !== undefined) {
      // keep caches honest without repainting
      const v = this.viewer.views[page];
      if (v) { v.annots = null; v.layout = null; }
      this.thumbs.invalidate(page);
    }
    await this.refreshInfo();
    return result;
  }

  /** Structural ops return DocInfo; rebuild page list. Throws on error. */
  async callStructural(method, args = {}, bytes = null) {
    closeTextEditor(false);
    const { result } = await this.call(method, args, bytes);
    this.setDirty(true);
    this.selection.deselect();
    if (method !== 'undo' && method !== 'redo') state.redactions.clear();
    this.applyDocInfo(result, true);
    return result;
  }

  invalidatePage(i) {
    this.viewer.invalidatePage(i);
    this.thumbs.invalidate(i);
    if (state.selected?.page === i) this.selection.draw().then(() => this.props.render());
  }

  async refreshInfo() {
    try {
      const { result } = await this.client.call(state.docId, 'info', {});
      this.applyDocInfo(result, false);
    } catch { /* ignore */ }
  }

  applyDocInfo(info, structural) {
    const prev = state.info;
    state.info = info;
    $('undoBtn').disabled = !info.canUndo;
    $('redoBtn').disabled = !info.canRedo;
    $('pageCount').textContent = info.pageCount;
    $('pageInput').max = info.pageCount;
    if (structural || !prev) {
      if (state.currentPage >= info.pageCount) state.currentPage = Math.max(0, info.pageCount - 1);
      this.viewer.renderGen++;
      this.viewer.build(info);
      this.thumbs.build(info);
      if (!this.search.bar.hidden && this.search.query) this.search.run(this.search.query);
      else this.search.clear();
      this.updateRedactBar();
      emit('doc-changed', info);
    }
    if (prev && prev.hasForms !== info.hasForms && state.tool === 'form') this.props.render();
  }

  async getAnnots(i) {
    const v = this.viewer.views[i];
    if (v?.annots) return v.annots;
    const { result } = await this.client.call(state.docId, 'listAnnotations', { page: i });
    if (v) v.annots = result.annots;
    return result.annots;
  }
  async getFields(i) {
    const v = this.viewer.views[i];
    if (v?.fields) return v.fields;
    const { result } = await this.client.call(state.docId, 'listFields', { page: i });
    if (v) v.fields = result.fields;
    return result.fields;
  }
  async getLayout(i) {
    const v = this.viewer.views[i];
    if (v?.layout) return v.layout;
    const { result } = await this.client.call(state.docId, 'textLayout', { page: i });
    if (v) v.layout = result;
    return result;
  }

  // ---------------- open / close ----------------
  /**
   * Open any supported file (non-PDF input is converted to PDF by the engine).
   * opts.pageSize: layout for reflowable inputs (DOCX, HTML, TXT...); opts.fileName overrides the title.
   * opts.skipDirtyCheck: caller already confirmed. Returns true when a document is now open.
   */
  async openFile(file, opts = {}) {
    if (!file) return false;
    if (!opts.skipDirtyCheck && state.dirty && !(await confirmDialog('Discard changes?', 'The current document has unsaved changes. Open another file anyway?', 'Discard & open', true))) return false;
    const bytes = await readFile(file);
    const docId = `doc${++this.docCounter}`;
    let info;
    busy(true);
    try {
      const args = { name: file.name };
      if (opts.pageSize) args.pageSize = opts.pageSize;
      ({ result: info } = await this.client.call(docId, 'open', args, bytes));
    } catch (e) {
      busy(false);
      if (e.code === 'needs_password') info = { needsPassword: true };
      else { this.reportError(e); this.client.close(docId).catch(() => {}); return false; }
    }
    busy(false);
    if (info.needsPassword) {
      const ok = await modal({
        title: 'Password required',
        body: `<p><strong>${file.name.replace(/</g, '&lt;')}</strong> is password protected.</p><label class="f">Password<input type="password" name="password" autocomplete="current-password"></label>`,
        ok: 'Unlock',
        validate: async (d) => {
          try {
            ({ result: info } = await this.client.call(docId, 'authenticate', { password: d.password }));
            return '';
          } catch (e) {
            return e.code === 'bad_password' ? 'Incorrect password, try again' : e.message;
          }
        },
      });
      if (!ok) { this.client.close(docId).catch(() => {}); return false; }
    }
    const name = opts.fileName || (/\.pdf$/i.test(file.name) ? file.name : file.name.replace(/\.[^.]+$/, '') + '.pdf');
    this.adoptDocument(docId, info, name, bytes.length);
    return true;
  }

  /** Make an engine document (already opened/created under docId) the current one. */
  adoptDocument(docId, info, fileName, originalSize) {
    const oldId = state.docId;
    if (oldId && oldId !== docId) this.client.close(oldId).catch(() => {});
    state.docId = docId;
    state.fileName = fileName;
    state.originalSize = originalSize;
    state.currentPage = 0;
    state.selected = null;
    state.selectedPages = new Set();
    state.redactions.clear();
    state.info = null;
    this.viewer.clear();
    this.setDirty(false);
    document.body.classList.remove('no-doc');
    $('landing').hidden = true;
    $('workspace').hidden = false;
    for (const id of ['docMenuBtn', 'zoomInBtn', 'zoomOutBtn', 'zoomSelect', 'pageInput', 'searchBtn', 'downloadBtn']) $(id).disabled = false;
    document.title = `${state.fileName} · PDF Studio`;
    this.applyDocInfo(info, true);
    state.fitMode = 'width';
    this.applyFit();
    this.viewer.scroller.scrollTop = 0;
    this.tools.set('select');
    this.props.render();
    $('viewer').focus();
  }

  // ---------------- create ----------------
  async newBlank() {
    if (state.dirty && !(await confirmDialog('Discard changes?', 'The current document has unsaved changes. Start a new PDF anyway?', 'Discard & create', true))) return;
    const r = await modal({
      title: 'New blank PDF',
      body: `<label class="f">Pages<input type="number" name="pages" min="1" max="1000" value="1"></label>
        <label class="f">Page size${PAGE_SIZE_SELECT}</label>`,
      ok: 'Create',
      validate: (d) => (Number(d.pages) >= 1 && Number(d.pages) <= 1000 ? '' : 'Pages must be between 1 and 1000'),
    });
    if (!r) return;
    const docId = `doc${++this.docCounter}`;
    try {
      busy(true);
      const { result: info } = await this.client.call(docId, 'create', { pages: Number(r.pages), pageSize: r.pageSize });
      this.adoptDocument(docId, info, 'Untitled.pdf', 0);
    } catch (e) {
      this.client.close(docId).catch(() => {});
      this.reportError(e);
    } finally {
      busy(false);
    }
  }

  /** Convert one or many files (Word, Excel, images, HTML, ...) into a single PDF. */
  async convertFiles(files) {
    if (!files) files = await pickFiles('convertInput');
    files = [...files];
    if (!files.length) return;
    if (state.dirty && !(await confirmDialog('Discard changes?', 'The current document has unsaved changes. Convert anyway?', 'Discard & convert', true))) return;
    const order = files.slice();
    const listHtml = () => order.map((f, i) => `<li data-i="${i}"><span class="ext">${escapeHtml((f.name.split('.').pop() || '').slice(0, 5))}</span>
        <span class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <button type="button" class="btn icon-btn sm" data-move="-1" aria-label="Move ${escapeHtml(f.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn icon-btn sm" data-move="1" aria-label="Move ${escapeHtml(f.name)} down" ${i === order.length - 1 ? 'disabled' : ''}>↓</button></li>`).join('');
    const r = await modal({
      title: files.length > 1 ? `Combine ${files.length} files into one PDF` : `Convert ${files[0].name} to PDF`,
      body: `${files.length > 1 ? '<p class="muted small">Pages follow this order.</p>' : ''}
        <ul class="convert-list" id="convertList">${listHtml()}</ul>
        <label class="f">Page size for documents and text${PAGE_SIZE_SELECT}</label>
        <p class="muted small">Images, PDFs and slides keep their own size.</p>`,
      ok: files.length > 1 ? 'Combine' : 'Convert',
      onOpen: (form) => {
        const list = form.querySelector('#convertList');
        list.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-move]');
          if (!btn) return;
          const i = Number(btn.closest('li').dataset.i);
          const j = i + Number(btn.dataset.move);
          if (j < 0 || j >= order.length) return;
          [order[i], order[j]] = [order[j], order[i]];
          list.innerHTML = listHtml();
        });
      },
    });
    if (!r) return;
    const fileName = order.length > 1 ? 'Combined.pdf' : undefined;
    const opened = await this.openFile(order[0], { pageSize: r.pageSize, fileName, skipDirtyCheck: true });
    if (!opened) return;
    if (order.length > 1) {
      await this.docops.insertFiles(order.slice(1), state.info.pageCount, { pageSize: r.pageSize });
      this.setDirty(true);
    } else if (!/\.pdf$/i.test(order[0].name)) {
      this.setDirty(true);  // converted content has not been saved as PDF yet
    }
  }

  /** Ask the engine which inputs it converts and use that for every file picker. */
  async loadFormats() {
    try {
      const { result } = await this.client.call('__formats', 'formats', {});
      this.client.close('__formats').catch(() => {});
      const accept = result.extensions.map((e) => '.' + e).join(',');
      for (const el of document.querySelectorAll('[data-accept-formats]')) el.accept = accept;
      this.formats = result.extensions;
    } catch {
      // keep the static accept lists from index.html
    }
  }

  async closeDocument() {
    if (state.dirty && !(await confirmDialog('Close document?', 'Unsaved changes will be lost.', 'Close', true))) return;
    if (state.docId) this.client.close(state.docId).catch(() => {});
    state.docId = null;
    state.info = null;
    this.viewer.clear();
    this.thumbs.clear();
    this.setDirty(false);
    document.body.classList.add('no-doc');
    $('landing').hidden = false;
    $('workspace').hidden = true;
    $('fileName').textContent = '';
    document.title = 'PDF Studio';
    for (const id of ['docMenuBtn', 'zoomInBtn', 'zoomOutBtn', 'zoomSelect', 'pageInput', 'searchBtn', 'downloadBtn', 'undoBtn', 'redoBtn']) $(id).disabled = true;
  }

  setDirty(d) {
    state.dirty = d;
    const el = $('fileName');
    el.innerHTML = '';
    el.textContent = state.fileName;
    el.title = state.fileName;
    if (d) el.insertAdjacentHTML('beforeend', '<span class="dirty" title="Unsaved changes">●</span>');
  }

  author() { return 'PDF Studio user'; }

  // ---------------- page ops ----------------
  rotatePages(pages, degrees) { return this.mutate('rotatePages', { pages, degrees }); }
  async deletePages(pages, silent = false) {
    if (pages.length >= state.info.pageCount) { toast('A document needs at least one page', 'error'); return; }
    if (!silent && !(await confirmDialog('Delete pages?', `Delete ${pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages`}? You can undo this.`, 'Delete', true))) return;
    state.selectedPages = new Set();
    await this.mutate('deletePages', { pages });
  }
  reorderPages(order) { state.selectedPages = new Set(); return this.mutate('reorderPages', { order }); }
  insertBlank(at) {
    const ref = state.info.pages[Math.max(0, Math.min(at - 1, state.info.pageCount - 1))];
    return this.mutate('insertBlankPage', { at, width: ref?.width ?? 595, height: ref?.height ?? 842 });
  }
  duplicatePages(pages) {
    const set = new Set(pages);
    const order = [];
    for (let i = 0; i < state.info.pageCount; i++) { order.push(i); if (set.has(i)) order.push(i); }
    return this.reorderPages(order);
  }

  async undo() { if (state.info?.canUndo) await this.mutate('undo'); }
  async redo() { if (state.info?.canRedo) await this.mutate('redo'); }

  // ---------------- zoom ----------------
  setZoom(s, fitMode = null) {
    state.fitMode = fitMode;
    const z = clampZoom(s);
    this.viewer.rescale(z);
    const sel = $('zoomSelect');
    if (fitMode) sel.value = fitMode;
    else {
      const match = [...sel.options].find((o) => Math.abs(Number(o.value) - z) < 1e-3);
      if (match) sel.value = match.value;
      else { const c = sel.querySelector('[value=custom]'); c.textContent = `${Math.round(z * 100)}%`; sel.value = 'custom'; }
    }
  }
  zoomBy(dir) { this.setZoom(nextZoom(state.scale, dir)); }
  applyFit() {
    if (!state.info || !state.fitMode) return;
    const sc = this.viewer.scroller;
    this.setZoom(fitScale(state.info.pages, sc.clientWidth, sc.clientHeight, state.fitMode), state.fitMode);
  }

  // ---------------- redaction ----------------
  renderRedactions(v) { renderRedactions(this, v); }
  applyRedactions() { return applyRedactions(this).then(() => this.props.render()); }
  updateRedactBar() {
    const n = [...state.redactions.values()].reduce((a, l) => a + l.length, 0);
    $('redactBar').hidden = !(n > 0);
    $('redactCount').textContent = `${n} area${n === 1 ? '' : 's'} marked for redaction`;
    if (state.tool === 'redact') this.props.render();
  }

  // ---------------- wiring ----------------
  wire() {
    // landing
    const drop = $('dropZone');
    drop.addEventListener('click', () => $('fileInput').click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
    $('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; this.openFile(f); });
    $('newBlankBtn').addEventListener('click', () => this.newBlank());
    $('convertBtn').addEventListener('click', () => this.convertFiles());
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; drop.classList.add('over'); if (state.info) document.body.classList.add('dragging-file'); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); document.body.classList.remove('dragging-file'); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      drop.classList.remove('over');
      document.body.classList.remove('dragging-file');
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      if (!state.info) {
        if (files.length > 1) this.convertFiles(files);
        else this.openFile(files[0]);
        return;
      }
      const r = await modal({
        title: 'Dropped files', ok: 'Continue',
        body: `<label class="c"><input type="radio" name="act" value="merge" checked> Merge into this document</label><label class="c"><input type="radio" name="act" value="open"> Open ${files.length > 1 ? 'the first file' : 'it'} instead</label>`,
      });
      if (!r) return;
      if (r.act === 'merge') this.docops.merge(files); else this.openFile(files[0]);
    });

    // top bar
    $('undoBtn').addEventListener('click', () => this.undo());
    $('redoBtn').addEventListener('click', () => this.redo());
    $('zoomInBtn').addEventListener('click', () => this.zoomBy(1));
    $('zoomOutBtn').addEventListener('click', () => this.zoomBy(-1));
    $('zoomSelect').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'width' || v === 'page') { state.fitMode = v; this.applyFit(); } else if (v !== 'custom') this.setZoom(Number(v));
    });
    $('pageInput').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(state.info?.pageCount || 1, Number(e.target.value) || 1));
      e.target.value = n;
      this.viewer.scrollToPage(n - 1);
    });
    $('searchBtn').addEventListener('click', () => this.search.open());
    $('downloadBtn').addEventListener('click', () => this.docops.download());
    $('redactApply').addEventListener('click', () => this.applyRedactions());
    $('redactClear').addEventListener('click', () => {
      state.redactions.clear();
      for (const v of this.viewer.views) renderRedactions(this, v);
      this.updateRedactBar();
    });

    // document menu
    const menuBtn = $('docMenuBtn'), menu = $('docMenu');
    const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        menu.querySelector('[data-action=decrypt]').disabled = !state.info?.encrypted;
        menu.querySelector('button')?.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) closeMenu(); });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); }
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      closeMenu();
      this.runAction(b.dataset.action);
    });

    // keyboard
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  async runAction(action) {
    try {
      switch (action) {
        case 'open': $('fileInput').click(); break;
        case 'newBlank': await this.newBlank(); break;
        case 'convert': await this.convertFiles(); break;
        case 'merge': await this.docops.merge(); break;
        case 'insertBlank': await this.insertBlank(state.currentPage + 1); break;
        case 'extract': await this.docops.extract(this.thumbs.targetPages()); break;
        case 'exportImage': await this.docops.exportImage(); break;
        case 'compress': await this.docops.compress(); break;
        case 'protect': await this.docops.protect(); break;
        case 'decrypt': await this.docops.decrypt(); break;
        case 'metadata': await this.docops.metadata(); break;
        case 'addFont': await this.docops.addFont(); break;
        case 'download': await this.docops.download(); break;
        case 'close': await this.closeDocument(); break;
        default: break;
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.target;
    const typing = t.closest?.('input, textarea, select, [contenteditable="true"]') || isEditingText();
    if ($('modal').open) return;
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); return; }
    if (!state.info) return;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.search.open(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.docops.download(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); this.zoomBy(1); return; }
    if (mod && e.key === '-') { e.preventDefault(); this.zoomBy(-1); return; }
    if (mod && e.key === '0') { e.preventDefault(); this.setZoom(1); return; }
    if (mod || e.altKey) return;
    if (this.tools.onKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (state.selected) this.selection.deselect();
      else if (state.tool !== 'select') this.tools.set('select');
      return;
    }
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); this.tools.set(tool); }
  }
}

const app = new App();
app.state = state;
window.__app = app; // handle for e2e tests and debugging
export default app;
