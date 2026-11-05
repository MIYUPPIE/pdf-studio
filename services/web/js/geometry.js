// Pure geometry helpers. No DOM access: everything here is unit tested with `node --test`.
// Page space (see contracts/engine-api.md): PDF points, origin top-left of displayed page, y down.

export const MIN_SIZE = 4;

export function normRect([x0, y0, x1, y1]) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function rectFromPoints(a, b) {
  return normRect([a[0], a[1], b[0], b[1]]);
}

export function rectWidth(r) { return r[2] - r[0]; }
export function rectHeight(r) { return r[3] - r[1]; }

export function rectUnion(a, b) {
  if (!a) return b ? [...b] : null;
  if (!b) return [...a];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function rectContains(r, [x, y], pad = 0) {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;
}

export function rectsIntersect(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function expandRect(r, d) {
  return [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
}

export function moveRect(r, dx, dy) {
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
}

export function clampRectToPage(r, w, h) {
  const rw = rectWidth(r), rh = rectHeight(r);
  const x0 = Math.min(Math.max(r[0], 0), Math.max(0, w - rw));
  const y0 = Math.min(Math.max(r[1], 0), Math.max(0, h - rh));
  return [x0, y0, x0 + rw, y0 + rh];
}

/** Resize rect by dragging handle (n, s, e, w, ne, nw, se, sw) by (dx, dy). */
export function resizeRect(r, handle, dx, dy, min = MIN_SIZE) {
  let [x0, y0, x1, y1] = r;
  if (handle.includes('w')) x0 = Math.min(x0 + dx, x1 - min);
  if (handle.includes('e')) x1 = Math.max(x1 + dx, x0 + min);
  if (handle.includes('n')) y0 = Math.min(y0 + dy, y1 - min);
  if (handle.includes('s')) y1 = Math.max(y1 + dy, y0 + min);
  return [x0, y0, x1, y1];
}

export function quadToRect(q) {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function rectToQuad([x0, y0, x1, y1]) {
  return [x0, y0, x1, y0, x0, y1, x1, y1];
}

export function pointsBounds(points, pad = 0) {
  let r = null;
  for (const [x, y] of points) r = rectUnion(r, [x, y, x, y]);
  return r ? expandRect(r, pad) : null;
}

export function inkBounds(ink, pad = 0) {
  return pointsBounds(ink.flat(), pad);
}

/** Map a point from one rect to another (used to scale ink/points when an annotation is resized). */
export function mapPoint([x, y], from, to) {
  const fw = rectWidth(from) || 1, fh = rectHeight(from) || 1;
  return [to[0] + ((x - from[0]) / fw) * rectWidth(to), to[1] + ((y - from[1]) / fh) * rectHeight(to)];
}

export function mapQuad(q, from, to) {
  const out = [];
  for (let i = 0; i < 8; i += 2) out.push(...mapPoint([q[i], q[i + 1]], from, to));
  return out;
}

/**
 * Build the partial AnnotSpec needed to move/resize an annotation from its current rect to `newRect`.
 * Geometry-carrying types also get their points/ink/quads remapped so the engine never has to guess.
 */
export function annotGeometryUpdate(annot, newRect) {
  const from = annot.rect;
  const upd = { rect: newRect.map(round2) };
  if (annot.ink) upd.ink = annot.ink.map((s) => s.map((p) => mapPoint(p, from, newRect).map(round2)));
  if (annot.points) upd.points = annot.points.map((p) => mapPoint(p, from, newRect).map(round2));
  if (annot.quads) upd.quads = annot.quads.map((q) => mapQuad(q, from, newRect).map(round2));
  return upd;
}

export function round2(v) { return Math.round(v * 100) / 100; }

/** Flatten a TextLayout into a reading-order char list. */
export function flattenChars(layout) {
  const chars = [];
  if (!layout) return chars;
  let lineNo = 0;
  for (const block of layout.blocks || []) {
    for (const line of block.lines || []) {
      const quads = line.chars || [];
      const text = Array.from(line.text || '');
      for (let i = 0; i < quads.length; i++) {
        chars.push({ line: lineNo, lineId: line.id, index: i, quad: quads[i], rect: quadToRect(quads[i]), ch: text[i] ?? '' });
      }
      lineNo++;
    }
  }
  return chars;
}

function distToRect([x, y], r) {
  const dx = Math.max(r[0] - x, 0, x - r[2]);
  const dy = Math.max(r[1] - y, 0, y - r[3]);
  return Math.hypot(dx, dy * 2); // vertical distance weighs more: prefer same line
}

export function nearestCharIndex(chars, pt, maxDist = Infinity) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < chars.length; i++) {
    const d = distToRect(pt, chars[i].rect);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= maxDist ? best : -1;
}

/** Union of two quads that lie on the same text line: left edge of `a`, right edge of `b`. */
export function joinQuads(a, b) {
  return [a[0], a[1], b[2], b[3], a[4], a[5], b[6], b[7]];
}

/**
 * Text selection between two page-space points -> one quad per line (suitable for Highlight etc.).
 * Returns { quads, text }.
 */
export function quadsForSelection(layout, a, b, maxDist = 40) {
  const chars = flattenChars(layout);
  if (!chars.length) return { quads: [], text: '' };
  let i = nearestCharIndex(chars, a, maxDist);
  let j = nearestCharIndex(chars, b, maxDist);
  if (i < 0 || j < 0) return { quads: [], text: '' };
  if (i > j) [i, j] = [j, i];
  const quads = [];
  let text = '';
  let start = chars[i], prev = chars[i];
  for (let k = i; k <= j; k++) {
    const c = chars[k];
    if (c.line !== start.line) {
      quads.push(joinQuads(start.quad, prev.quad));
      text += '\n';
      start = c;
    }
    text += c.ch;
    prev = c;
  }
  quads.push(joinQuads(start.quad, prev.quad));
  return { quads, text };
}

/** Find the text line whose bbox contains pt (or nearest within pad). */
export function lineAt(layout, pt, pad = 2) {
  let best = null, bestD = Infinity;
  for (const block of layout?.blocks || []) {
    for (const line of block.lines || []) {
      if (rectContains(line.bbox, pt, pad)) {
        const d = Math.abs((line.bbox[1] + line.bbox[3]) / 2 - pt[1]);
        if (d < bestD) { bestD = d; best = line; }
      }
    }
  }
  return best;
}

/** Dominant (longest) span of a line: drives font size/color of the edit box. */
export function dominantSpan(line) {
  let best = null;
  for (const s of line?.spans || []) if (!best || (s.text || '').length > (best.text || '').length) best = s;
  return best;
}

/** Zoom presets and fit computation. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(scale, dir) {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale + 1e-3) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - 1e-3) ?? ZOOM_STEPS[0];
}

export function fitScale(pages, viewW, viewH, mode, margin = 32) {
  if (!pages?.length) return 1;
  const maxW = Math.max(...pages.map((p) => p.width));
  const firstH = pages[0].height;
  const sw = (viewW - margin) / maxW;
  if (mode === 'width') return clampZoom(sw);
  const sh = (viewH - margin) / firstH;
  return clampZoom(Math.min(sw, sh));
}

export function clampZoom(s) { return Math.min(5, Math.max(0.1, s)); }

/**
 * Thumbnail drag: move the `moving` page indices so they land before `target`
 * (target == count means "at end"). Returns the reorderPages `order` array.
 */
export function computeReorder(count, moving, target) {
  const set = new Set(moving);
  const rest = [];
  for (let i = 0; i < count; i++) if (!set.has(i)) rest.push(i);
  const before = [...set].filter((i) => i < target).length;
  const insertAt = Math.max(0, Math.min(rest.length, target - before));
  const sorted = [...set].sort((a, b) => a - b);
  return [...rest.slice(0, insertAt), ...sorted, ...rest.slice(insertAt)];
}

export function isIdentityOrder(order) {
  return order.every((v, i) => v === i);
}

/** Line annotation with arrow: rect that bounds both endpoints plus stroke padding. */
export function lineRect(p0, p1, width = 1) {
  return expandRect(rectFromPoints(p0, p1), Math.max(4, width * 3));
}

/** Rect for an image of natural size (w,h) placed centred on pt, max `maxW` points wide. */
export function imagePlacementRect(pt, natW, natH, maxW = 200, maxH = 200) {
  const s = Math.min(maxW / natW, maxH / natH, 1);
  const w = natW * s, h = natH * s;
  return [pt[0] - w / 2, pt[1] - h / 2, pt[0] + w / 2, pt[1] + h / 2].map(round2);
}

/** Simplify a freehand stroke (radial distance), keeps first/last points. */
export function simplifyStroke(points, minDist = 0.75) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => Math.round(v * 1000) / 1000);
}

export function rgbToHex(c) {
  if (!c) return '#000000';
  return '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export function rgbCss(c, alpha = 1) {
  if (!c) return 'transparent';
  const [r, g, b] = c.map((v) => Math.round(v * 255));
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}

/** Parse a page-range string like "1-3, 5, 8-" (1-based) into 0-based indices. */
export function parsePageRange(str, count) {
  const out = new Set();
  for (const part of String(str).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : count;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= count) out.add(n - 1);
    } else {
      throw new Error(`Invalid page range: "${part}"`);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function formatPageRange(indices) {
  const s = [...indices].sort((a, b) => a - b).map((i) => i + 1);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return parts.join(', ');
}

export function baseName(name) {
  return String(name || 'document').replace(/\.[^.]+$/, '') || 'document';
}
