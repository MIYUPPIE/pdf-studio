// Inline SVG icons (24x24, stroke-based). Self-hosted: no network needed.
const P = {
  select: '<path d="M5 3l14 8-6 2-3 6z"/>',
  chevleft: '<path d="M15 6l-6 6 6 6"/>',
  chevright: '<path d="M9 6l6 6-6 6"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  edittext: '<path d="M4 7V5h12v2M10 5v14M7 19h6"/><path d="M15 15l4-4 2 2-4 4h-2z"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>',
  draw: '<path d="M3 20c3-1 4-3 6-6s4-8 7-9 4 2 2 5-6 7-6 9 4 1 6-1"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  highlight: '<path d="M9 11l-5 5v3h3l5-5"/><path d="M9 11l6-6 4 4-6 6z"/><path d="M14 20h7"/>',
  underline: '<path d="M7 4v6a5 5 0 0 0 10 0V4M5 20h14"/>',
  strike: '<path d="M4 12h16M16 6a4 3 0 0 0-8 1c0 2 8 3 8 6a4 3 0 0 1-8 1"/>',
  note: '<path d="M4 4h16v12h-6l-4 4v-4H4z"/>',
  signature: '<path d="M3 17c2 0 3-6 5-6s1 6 3 6 3-4 4-4 1 3 3 3h3"/><path d="M3 21h18"/>',
  redact: '<rect x="3" y="7" width="18" height="10" rx="1" fill="currentColor"/>',
  form: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 14h10"/><rect x="15" y="7.5" width="3" height="3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/>',
  rotateleft: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  extract: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M12 11v6M9 14l3 3 3-3"/>',
  merge: '<path d="M6 3v6a6 6 0 0 0 6 6h6M18 21v-6"/><path d="M15 12l3 3-3 3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevup: '<path d="M6 15l6-6 6 6"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
  fitwidth: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  fitpage: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 9h6v6H9z"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  shapes: '<rect x="3" y="3" width="10" height="10"/><circle cx="16" cy="16" r="5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || P.file;
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Replace every [data-icon] element's content with its SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.dataset.iconDone = '1';
  }
}
