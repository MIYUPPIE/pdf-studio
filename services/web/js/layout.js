// Responsive layout: panel state (pages sidebar, properties), drawers on narrow
// screens, theme, page stepping, and touch gestures (pinch to zoom).
//
// Panel state is two attributes on <body>, styled by css/app.css:
//   data-side="open|closed"    pages sidebar (column on wide screens, drawer on phones)
//   data-props="open|closed"   properties (column on desktop, drawer/bottom sheet below 1200px)
import { state } from './state.js';
import { icon } from './icons.js';
import { clampZoom } from './geometry.js';

const $ = (id) => document.getElementById(id);
export const BREAK = { desktop: '(min-width: 1200px)', phone: '(max-width: 767px)' };
const THEMES = ['auto', 'light', 'dark'];
const THEME_KEY = 'pdfstudio.theme';

export function layoutMode() {
  if (matchMedia(BREAK.phone).matches) return 'phone';
  if (matchMedia(BREAK.desktop).matches) return 'desktop';
  return 'tablet';
}

/** Default panel visibility for a layout mode. */
export function defaultPanels(mode) {
  if (mode === 'desktop') return { side: 'open', props: 'open' };
  if (mode === 'tablet') return { side: 'open', props: 'closed' };
  return { side: 'closed', props: 'closed' };
}

function readTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}
function writeTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode: theme just isn't remembered */ }
}

export class Layout {
  constructor(app) {
    this.app = app;
    this.body = document.body;
    this.mode = layoutMode();
    this.applyDefaults();
    this.setTheme(readTheme(), false);
    this.wire();
  }

  applyDefaults() {
    const d = defaultPanels(this.mode);
    this.set('side', d.side, false);
    this.set('props', d.props, false);
  }

  /** Overlay drawers (as opposed to grid columns) are open: show the scrim. */
  isOverlay(which) {
    if (which === 'side') return this.mode === 'phone';
    return this.mode !== 'desktop';
  }

  set(which, value, refit = true) {
    this.body.dataset[which] = value;
    const btn = $(which === 'side' ? 'sidebarToggle' : 'propsToggle');
    btn?.setAttribute('aria-expanded', String(value === 'open'));
    // Only one overlay drawer at a time.
    if (value === 'open' && this.isOverlay(which)) {
      const other = which === 'side' ? 'props' : 'side';
      if (this.isOverlay(other) && this.body.dataset[other] === 'open') this.set(other, 'closed', false);
    }
    const overlayOpen = ['side', 'props'].some((w) => this.isOverlay(w) && this.body.dataset[w] === 'open');
    $('scrim').hidden = !overlayOpen;
    // A column changed width: keep "fit" zoom modes fitted once the transition ends.
    if (refit && !this.isOverlay(which)) setTimeout(() => this.app.applyFit(), 260);
  }

  toggle(which) { this.set(which, this.body.dataset[which] === 'open' ? 'closed' : 'open'); }
  closeOverlays() {
    for (const w of ['side', 'props']) if (this.isOverlay(w) && this.body.dataset[w] === 'open') this.set(w, 'closed', false);
  }

  setTheme(t, save = true) {
    if (!THEMES.includes(t)) t = 'auto';
    this.theme = t;
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const btn = $('themeBtn');
    if (btn) {
      btn.innerHTML = icon(t === 'auto' ? 'monitor' : t === 'light' ? 'sun' : 'moon');
      const label = `Theme: ${t === 'auto' ? 'automatic' : t}`;
      btn.setAttribute('aria-label', label);
      btn.dataset.tip = label;
    }
    if (save) writeTheme(t);
  }
  cycleTheme() { this.setTheme(THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length]); }

  stepPage(delta) {
    if (!state.info) return;
    const n = Math.min(state.info.pageCount - 1, Math.max(0, state.currentPage + delta));
    this.app.viewer.scrollToPage(n);
  }

  wire() {
    $('sidebarToggle').addEventListener('click', () => this.toggle('side'));
    $('propsToggle').addEventListener('click', () => this.toggle('props'));
    $('scrim').addEventListener('click', () => this.closeOverlays());
    $('themeBtn').addEventListener('click', () => this.cycleTheme());
    $('openBtn').addEventListener('click', () => $('fileInput').click());
    $('prevPageBtn').addEventListener('click', () => this.stepPage(-1));
    $('nextPageBtn').addEventListener('click', () => this.stepPage(1));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('scrim').hidden && !document.querySelector('dialog[open]')) this.closeOverlays();
    });
    // Picking a page from the drawer on a phone closes the drawer.
    $('thumbs').addEventListener('click', () => {
      if (this.mode === 'phone') setTimeout(() => this.set('side', 'closed', false), 120);
    });
    // Breakpoint changes reset panels to that layout's defaults.
    const onMode = () => {
      const m = layoutMode();
      if (m === this.mode) return;
      this.mode = m;
      this.applyDefaults();
    };
    matchMedia(BREAK.phone).addEventListener('change', onMode);
    matchMedia(BREAK.desktop).addEventListener('change', onMode);
    // Page count badge in the sidebar header.
    const count = $('pageCount');
    new MutationObserver(() => { $('sideCount').textContent = count.textContent === '0' ? '' : count.textContent; })
      .observe(count, { childList: true, characterData: true, subtree: true });
    this.wirePinch();
  }

  /** Two-finger pinch on the viewer zooms the document (one finger scrolls). */
  wirePinch() {
    const sc = $('viewer');
    let start = null;
    let raf = 0;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && state.info) start = { d: dist(e.touches), scale: state.scale };
    }, { passive: true });
    sc.addEventListener('touchmove', (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const target = clampZoom(start.scale * (dist(e.touches) / start.d));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.app.setZoom(target));
    }, { passive: false });
    const end = (e) => { if (e.touches.length < 2) start = null; };
    sc.addEventListener('touchend', end);
    sc.addEventListener('touchcancel', end);
  }
}
