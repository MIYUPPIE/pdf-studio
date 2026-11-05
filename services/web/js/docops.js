// Document-level operations: merge, extract/split, export image, compress, protect, decrypt,
// metadata, custom fonts, download.
import { state } from './state.js';
import { modal, toast, downloadBytes, formatBytes, escapeHtml, readFile, promptDialog } from './dialogs.js';
import { parsePageRange, formatPageRange, baseName } from './geometry.js';
import { pickFile } from './tools/common.js';

export class DocOps {
  constructor(app) { this.app = app; }
  get name() { return baseName(state.fileName); }

  async merge(files) {
    if (!files) {
      files = await new Promise((resolve) => {
        const input = document.getElementById('mergeInput');
        input.value = '';
        input.onchange = () => resolve([...input.files]);
        input.oncancel = () => resolve([]);
        input.click();
      });
    }
    files = [...files];
    if (!files.length) return;
    const cur = state.currentPage + 1;
    const res = await modal({
      title: `Merge ${files.length} file${files.length > 1 ? 's' : ''}`,
      body: `<p class="muted small">${files.map((f) => escapeHtml(f.name)).join('<br>')}</p>
        <label class="f">Insert
          <select name="where">
            <option value="end">At the end</option>
            <option value="after">After current page (${cur})</option>
            <option value="start">At the beginning</option>
          </select></label>`,
      ok: 'Merge',
    });
    if (!res) return;
    const at = res.where === 'start' ? 0 : res.where === 'after' ? cur : state.info.pageCount;
    await this.insertFiles(files, at);
  }

  /** Insert files (any supported format) at page index `at`, in order. extra: e.g. {pageSize}. */
  async insertFiles(files, at, extra = {}) {
    let added = 0;
    for (const f of files) {
      const bytes = await readFile(f);
      let password;
      for (;;) {
        try {
          const before = state.info.pageCount;
          const info = await this.app.callStructural('insertDocument', { at, name: f.name, ...extra, ...(password ? { password } : {}) }, bytes);
          const n = info.pageCount - before;
          added++;
          at += Math.max(0, n);
          break;
        } catch (e) {
          if (e.code === 'needs_password' || e.code === 'bad_password') {
            password = await promptDialog(`"${f.name}" is password protected`, 'Password', '', { type: 'password', ok: 'Unlock' });
            if (password === null) break;
            continue;
          }
          this.app.reportError(e);
          break;
        }
      }
    }
    if (added) toast(`Merged ${added} file${added > 1 ? 's' : ''}`, 'success');
  }

  async extract(pages) {
    const n = state.info.pageCount;
    const preset = formatPageRange(pages?.length ? pages : [state.currentPage]);
    const res = await modal({
      title: 'Extract / split pages',
      body: `<label class="f">Pages (e.g. 1-3, 5, 8-)<input type="text" name="range" value="${escapeHtml(preset)}"></label>
        <label class="c"><input type="radio" name="mode" value="one" checked> Save as one PDF</label>
        <label class="c"><input type="radio" name="mode" value="each"> Split: one PDF per page</label>
        <label class="c"><input type="checkbox" name="remove"> Remove extracted pages from this document</label>`,
      ok: 'Extract',
      validate: (d) => {
        try { return parsePageRange(d.range, n).length ? '' : 'No valid pages in range'; } catch (e) { return e.message; }
      },
    });
    if (!res) return;
    const list = parsePageRange(res.range, n);
    if (res.mode === 'each') {
      for (const p of list) {
        const { bytes } = await this.app.call('extractPages', { pages: [p] });
        downloadBytes(bytes, `${this.name}-page-${p + 1}.pdf`);
      }
    } else {
      const { bytes } = await this.app.call('extractPages', { pages: list });
      downloadBytes(bytes, `${this.name}-pages-${formatPageRange(list).replace(/\s/g, '')}.pdf`);
    }
    if (res.remove && list.length < n) await this.app.deletePages(list, true);
    toast(`Extracted ${list.length} page${list.length > 1 ? 's' : ''}`, 'success');
  }

  async exportImage() {
    const res = await modal({
      title: 'Export page as image',
      body: `<div class="grid2">
        <label class="f">Page<input type="number" name="page" min="1" max="${state.info.pageCount}" value="${state.currentPage + 1}"></label>
        <label class="f">Format<select name="format"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label>
        <label class="f">Resolution<select name="dpi"><option>72</option><option selected>150</option><option>300</option><option>600</option></select></label></div>`,
      ok: 'Export',
      validate: (d) => (d.page >= 1 && d.page <= state.info.pageCount ? '' : 'Page out of range'),
    });
    if (!res) return;
    const page = Number(res.page) - 1;
    const { bytes } = await this.app.call('exportPageImage', { page, dpi: Number(res.dpi), format: res.format });
    downloadBytes(bytes, `${this.name}-page-${page + 1}.${res.format === 'jpeg' ? 'jpg' : 'png'}`, res.format === 'jpeg' ? 'image/jpeg' : 'image/png');
  }

  async compress() {
    const res = await modal({
      title: 'Compress PDF',
      body: `<label class="f">Image quality
          <select name="dpi"><option value="72">Smallest (72 dpi)</option><option value="110">Small (110 dpi)</option><option value="150" selected>Balanced (150 dpi)</option><option value="220">High (220 dpi)</option></select></label>
        <label class="c"><input type="checkbox" name="images" checked> Downsample large images</label>
        <p class="muted small">Unused objects are removed and streams are recompressed. Original size: ${formatBytes(state.originalSize)}.</p>`,
      ok: 'Compress & download',
    });
    if (!res) return;
    const { result, bytes } = await this.app.call('save', { garbage: 4, compress: true, compressImages: !!res.images, imageDpi: Number(res.dpi) });
    downloadBytes(bytes, `${this.name}-compressed.pdf`);
    const before = state.originalSize;
    const pct = before ? Math.round((1 - result.size / before) * 100) : 0;
    toast(`Compressed: ${formatBytes(before)} → ${formatBytes(result.size)}${pct > 0 ? ` (−${pct}%)` : ''}`, 'success', 6000);
  }

  async protect() {
    const res = await modal({
      title: 'Protect with password',
      body: `<label class="f">Password to open (leave empty to allow opening without one)<input type="password" name="user" autocomplete="new-password"></label>
        <label class="f">Owner password (required, controls permissions)<input type="password" name="owner" autocomplete="new-password"></label>
        <label class="f">Confirm owner password<input type="password" name="owner2" autocomplete="new-password"></label>
        <fieldset style="border:1px solid var(--border);border-radius:8px;padding:8px 12px"><legend class="small muted">Allow</legend>
          <label class="c"><input type="checkbox" name="print" checked> Printing</label>
          <label class="c"><input type="checkbox" name="copy" checked> Copying text</label>
          <label class="c"><input type="checkbox" name="edit"> Editing</label>
          <label class="c"><input type="checkbox" name="annotate" checked> Comments</label>
          <label class="c"><input type="checkbox" name="forms" checked> Filling forms</label>
        </fieldset>
        <p class="muted small">Encrypted with AES-256.</p>`,
      ok: 'Protect & download',
      validate: (d) => {
        if (!d.owner) return 'Owner password is required';
        if (d.owner !== d.owner2) return 'Owner passwords do not match';
        return '';
      },
    });
    if (!res) return;
    const encrypt = {
      ownerPassword: res.owner,
      permissions: { print: res.print, copy: res.copy, edit: res.edit, annotate: res.annotate, forms: res.forms },
    };
    if (res.user) encrypt.userPassword = res.user;
    const { bytes } = await this.app.call('save', { garbage: 3, compress: true, encrypt });
    downloadBytes(bytes, `${this.name}-protected.pdf`);
    toast('Protected PDF downloaded', 'success');
  }

  async decrypt() {
    if (!state.info.encrypted) { toast('This document is not password protected'); return; }
    const { bytes } = await this.app.call('save', { garbage: 3, compress: true, decrypt: true });
    downloadBytes(bytes, `${this.name}-unlocked.pdf`);
    toast('Unlocked PDF downloaded', 'success');
  }

  async metadata() {
    const { result: m } = await this.app.call('getMetadata', {});
    const f = (k, l) => `<label class="f">${l}<input type="text" name="${k}" value="${escapeHtml(m[k] || '')}"></label>`;
    const res = await modal({
      title: 'Document properties',
      body: `${f('title', 'Title')}${f('author', 'Author')}${f('subject', 'Subject')}${f('keywords', 'Keywords')}
        <p class="muted small">Creator: ${escapeHtml(m.creator || '—')} · Producer: ${escapeHtml(m.producer || '—')} · ${state.info.pageCount} pages</p>`,
      ok: 'Save',
    });
    if (!res) return;
    await this.app.mutate('setMetadata', { title: res.title, author: res.author, subject: res.subject, keywords: res.keywords }, null, { rerender: false });
    toast('Properties updated', 'success');
  }

  async addFont() {
    const file = await pickFile('fontInput');
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '');
    const { result } = await this.app.call('registerFont', { name }, await readFile(file));
    if (!state.fonts.includes(result.name)) state.fonts.push(result.name);
    this.app.props.render();
    toast(`Font "${result.name}" added. Pick it in Edit text → Font.`, 'success');
  }

  async download() {
    const res = await modal({
      title: 'Download PDF',
      body: `<label class="f">File name<input type="text" name="name" value="${escapeHtml(this.name)}.pdf"></label>
        <label class="c"><input type="checkbox" name="flatten"> Flatten annotations and form fields (makes them part of the page, not editable)</label>`,
      ok: 'Download',
      validate: (d) => (d.name.trim() ? '' : 'File name is required'),
    });
    if (!res) return;
    const { bytes } = await this.app.call('save', { garbage: 3, compress: true, flatten: !!res.flatten });
    let fname = res.name.trim();
    if (!/\.pdf$/i.test(fname)) fname += '.pdf';
    downloadBytes(bytes, fname);
    this.app.setDirty(false);
    toast('Downloaded', 'success');
  }
}
