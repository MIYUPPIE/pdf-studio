// Shared UI state + a tiny event bus.

export const TOOL_DEFAULTS = {
  select: {},
  edittext: { font: 'original' },
  text: { color: '#111111', fontSize: 14, font: 'Helv' },
  image: {},
  draw: { color: '#1d4ed8', width: 2, opacity: 1 },
  rect: { color: '#e5484d', fill: '', width: 2, opacity: 1 },
  ellipse: { color: '#e5484d', fill: '', width: 2, opacity: 1 },
  line: { color: '#e5484d', width: 2, opacity: 1 },
  arrow: { color: '#e5484d', width: 2, opacity: 1 },
  highlight: { color: '#ffd400', opacity: 0.5 },
  underline: { color: '#2563eb', opacity: 1 },
  strike: { color: '#dc2626', opacity: 1 },
  note: { color: '#ffd400' },
  signature: { color: '#111827', width: 2 },
  form: { mode: 'fill' },
  redact: { fill: '#000000' },
};

export const state = {
  docId: null,
  info: null,
  fileName: '',
  originalSize: 0,
  scale: 1,
  fitMode: 'width', // 'width' | 'page' | null (explicit zoom)
  tool: 'select',
  toolProps: structuredClone(TOOL_DEFAULTS),
  selected: null, // {page, id}
  currentPage: 0,
  selectedPages: new Set(),
  redactions: new Map(), // page -> [{rect}]
  dirty: false,
  signature: null, // {kind:'ink', strokes, w, h} | {kind:'image', bytes, w, h}
  fonts: [], // registered custom fonts
};

const bus = new EventTarget();
export function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }
export function on(name, fn) { bus.addEventListener(name, (e) => fn(e.detail)); }

export function props(tool = state.tool) { return state.toolProps[tool] || {}; }
