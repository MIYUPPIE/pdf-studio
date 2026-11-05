// Toasts, busy overlay and modal dialogs built on <dialog>.

const toasts = () => document.getElementById('toasts');

export function toast(message, type = 'info', ms = type === 'error' ? 6000 : 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  toasts().appendChild(el);
  setTimeout(() => el.remove(), ms);
  el.addEventListener('click', () => el.remove());
  return el;
}

let busyCount = 0;
let busyTimer = null;
export function busy(on) {
  const el = document.getElementById('busy');
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (busyCount > 0) {
    if (!busyTimer && el.hidden) busyTimer = setTimeout(() => { busyTimer = null; if (busyCount > 0) el.hidden = false; }, 250);
  } else {
    clearTimeout(busyTimer); busyTimer = null;
    el.hidden = true;
  }
}

export async function withBusy(fn) {
  busy(true);
  try { return await fn(); } finally { busy(false); }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Generic modal.
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.body       inner HTML of the form body (inputs need name=)
 * @param {string} [o.ok]       OK button label
 * @param {string} [o.cancel]   Cancel label (null hides it)
 * @param {boolean} [o.danger]
 * @param {(data: object, form: HTMLFormElement) => (string|void|Promise<string|void>)} [o.validate]
 *        return an error string to keep the dialog open
 * @param {(form: HTMLFormElement, dialog: HTMLDialogElement) => void} [o.onOpen]
 * @returns {Promise<object|null>} form data (checkboxes -> boolean) or null on cancel
 */
export function modal(o) {
  const dlg = document.getElementById('modal');
  if (dlg.open) dlg.close('replaced');
  dlg.innerHTML = `
    <form method="dialog" novalidate>
      <header id="modalTitle">${escapeHtml(o.title)}</header>
      <div class="body">${o.body || ''}<div class="error-text" role="alert"></div></div>
      <footer>
        ${o.cancel === null ? '' : `<button type="button" class="btn" value="cancel" data-cancel>${escapeHtml(o.cancel || 'Cancel')}</button>`}
        <button type="submit" class="btn ${o.danger ? 'danger-solid' : 'primary'}" value="ok" data-ok>${escapeHtml(o.ok || 'OK')}</button>
      </footer>
    </form>`;
  dlg.setAttribute('aria-labelledby', 'modalTitle');
  const form = dlg.querySelector('form');
  const err = dlg.querySelector('.error-text');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }, { once: true });
    dlg.addEventListener('close', () => finish(null), { once: true });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = collect(form);
      if (o.validate) {
        const okBtn = form.querySelector('[data-ok]');
        okBtn.disabled = true;
        try {
          const msg = await o.validate(data, form);
          if (msg) { err.textContent = msg; return; }
        } catch (ex) {
          err.textContent = ex.message || String(ex);
          return;
        } finally {
          okBtn.disabled = false;
        }
      }
      finish(data);
    });
    dlg.showModal();
    o.onOpen?.(form, dlg);
    const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea');
    (first || form.querySelector('[data-ok]'))?.focus();
  });
}

function collect(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
    else data[el.name] = el.value;
  }
  return data;
}

export async function confirmDialog(title, message, ok = 'OK', danger = false) {
  const r = await modal({ title, body: `<p>${escapeHtml(message)}</p>`, ok, danger });
  return r !== null;
}

export async function promptDialog(title, label, value = '', { type = 'text', multiline = false, placeholder = '', ok = 'OK', validate } = {}) {
  const input = multiline
    ? `<textarea name="value" rows="4" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
    : `<input name="value" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off">`;
  const r = await modal({ title, body: `<label class="f">${escapeHtml(label)}${input}</label>`, ok, validate: validate ? (d) => validate(d.value) : undefined });
  return r ? r.value : null;
}

/** Context/popup menu at a screen position. items: [{label, icon?, action, disabled?} | '-'] */
export function contextMenu(x, y, items, iconFn) {
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.disabled = !!it.disabled;
    b.innerHTML = `${it.icon && iconFn ? iconFn(it.icon) : ''}<span>${escapeHtml(it.label)}</span>`;
    b.addEventListener('click', () => { hide(); it.action(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  const hide = () => {
    menu.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e) => { if (!menu.contains(e.target)) hide(); };
  const esc = (e) => { if (e.key === 'Escape') hide(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
  });
  menu.querySelector('button:not(:disabled)')?.focus();
  return hide;
}

/** Trigger a browser download of bytes. */
export function downloadBytes(bytes, filename, mime = 'application/pdf') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function readFile(file) {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}
