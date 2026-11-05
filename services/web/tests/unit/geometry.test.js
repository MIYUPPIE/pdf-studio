import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../../js/geometry.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const closeArr = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => close(v, b[i], eps)); };

// A tiny layout: two lines of 4 chars each, 10pt wide chars.
function layout() {
  const line = (id, text, y) => ({
    id, text, bbox: [0, y, 40, y + 12], dir: [1, 0], wmode: 0, spans: [{ text, size: 12, bbox: [0, y, 40, y + 12] }],
    chars: Array.from(text).map((_, i) => [i * 10, y, i * 10 + 10, y, i * 10, y + 12, i * 10 + 10, y + 12]),
  });
  return { blocks: [{ bbox: [0, 0, 40, 32], lines: [line('0-0', 'abcd', 0), line('0-1', 'efgh', 20)] }] };
}

test('normRect / rectFromPoints order corners', () => {
  assert.deepEqual(g.normRect([10, 20, 0, 5]), [0, 5, 10, 20]);
  assert.deepEqual(g.rectFromPoints([5, 5], [1, 9]), [1, 5, 5, 9]);
});

test('rectUnion handles null', () => {
  assert.deepEqual(g.rectUnion(null, [1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(g.rectUnion([0, 0, 1, 1], [2, -1, 3, 0.5]), [0, -1, 3, 1]);
  assert.equal(g.rectUnion(null, null), null);
});

test('rectContains with padding, rectsIntersect', () => {
  assert.ok(g.rectContains([0, 0, 10, 10], [5, 5]));
  assert.ok(!g.rectContains([0, 0, 10, 10], [11, 5]));
  assert.ok(g.rectContains([0, 0, 10, 10], [11, 5], 2));
  assert.ok(g.rectsIntersect([0, 0, 10, 10], [5, 5, 15, 15]));
  assert.ok(!g.rectsIntersect([0, 0, 10, 10], [10, 0, 20, 10])); // touching edges do not intersect
});

test('resizeRect per handle and minimum size', () => {
  const r = [10, 10, 50, 50];
  assert.deepEqual(g.resizeRect(r, 'se', 10, 5), [10, 10, 60, 55]);
  assert.deepEqual(g.resizeRect(r, 'nw', -5, -5), [5, 5, 50, 50]);
  assert.deepEqual(g.resizeRect(r, 'e', -100, 0), [10, 10, 14, 50]); // clamped to MIN_SIZE
  assert.deepEqual(g.resizeRect(r, 'n', 0, 100), [10, 46, 50, 50]);
  assert.deepEqual(g.resizeRect(r, 's', 3, 3), [10, 10, 50, 53]); // s ignores dx
});

test('quad <-> rect', () => {
  assert.deepEqual(g.rectToQuad([1, 2, 3, 4]), [1, 2, 3, 2, 1, 4, 3, 4]);
  assert.deepEqual(g.quadToRect([1, 2, 3, 2, 1, 4, 3, 4]), [1, 2, 3, 4]);
  // rotated quad bounds
  assert.deepEqual(g.quadToRect([5, 0, 10, 5, 0, 5, 5, 10]), [0, 0, 10, 10]);
});

test('mapPoint maps between rects', () => {
  closeArr(g.mapPoint([15, 15], [10, 10, 20, 20], [0, 0, 100, 100]), [50, 50]);
  closeArr(g.mapPoint([10, 20], [10, 10, 20, 20], [0, 0, 100, 50]), [0, 50]);
});

test('annotGeometryUpdate moves ink, points and quads with the rect', () => {
  const ink = { rect: [0, 0, 10, 10], ink: [[[0, 0], [10, 10]]] };
  assert.deepEqual(g.annotGeometryUpdate(ink, [5, 5, 15, 15]), { rect: [5, 5, 15, 15], ink: [[[5, 5], [15, 15]]] });
  const line = { rect: [0, 0, 10, 10], points: [[0, 0], [10, 10]] };
  assert.deepEqual(g.annotGeometryUpdate(line, [0, 0, 20, 20]).points, [[0, 0], [20, 20]]);
  const hl = { rect: [0, 0, 10, 10], quads: [[0, 0, 10, 0, 0, 10, 10, 10]] };
  assert.deepEqual(g.annotGeometryUpdate(hl, [10, 0, 20, 10]).quads, [[10, 0, 20, 0, 10, 10, 20, 10]]);
  const sq = { rect: [0, 0, 10, 10] };
  assert.deepEqual(g.annotGeometryUpdate(sq, [1, 1, 2, 2]), { rect: [1, 1, 2, 2] });
});

test('flattenChars keeps reading order and line numbers', () => {
  const chars = g.flattenChars(layout());
  assert.equal(chars.length, 8);
  assert.equal(chars[4].line, 1);
  assert.equal(chars[4].ch, 'e');
  assert.equal(chars[4].lineId, '0-1');
  assert.deepEqual(g.flattenChars(null), []);
});

test('quadsForSelection: single line partial', () => {
  const { quads, text } = g.quadsForSelection(layout(), [11, 5], [29, 5]);
  assert.equal(text, 'bc');
  assert.deepEqual(quads, [[10, 0, 30, 0, 10, 12, 30, 12]]);
});

test('quadsForSelection: backwards drag across lines gives one quad per line', () => {
  const { quads, text } = g.quadsForSelection(layout(), [15, 25], [25, 5]);
  assert.equal(text, 'cd\nef');
  assert.equal(quads.length, 2);
  assert.deepEqual(quads[0], [20, 0, 40, 0, 20, 12, 40, 12]);
  assert.deepEqual(quads[1], [0, 20, 20, 20, 0, 32, 20, 32]);
});

test('quadsForSelection: far away from text returns nothing', () => {
  assert.deepEqual(g.quadsForSelection(layout(), [500, 500], [600, 600]).quads, []);
  assert.deepEqual(g.quadsForSelection({ blocks: [] }, [0, 0], [1, 1]).quads, []);
});

test('lineAt picks the line under the point', () => {
  assert.equal(g.lineAt(layout(), [5, 25]).id, '0-1');
  assert.equal(g.lineAt(layout(), [5, 16]), null);
  assert.equal(g.lineAt(layout(), [5, 13.5]).id, '0-0'); // within 2pt pad
});

test('dominantSpan picks longest span', () => {
  assert.equal(g.dominantSpan({ spans: [{ text: 'a' }, { text: 'abc' }, { text: 'ab' }] }).text, 'abc');
  assert.equal(g.dominantSpan({ spans: [] }), null);
});

test('zoom steps and fit', () => {
  assert.equal(g.nextZoom(1, 1), 1.1);
  assert.equal(g.nextZoom(1, -1), 0.9);
  assert.equal(g.nextZoom(5, 1), 5);
  assert.equal(g.nextZoom(0.25, -1), 0.25);
  assert.equal(g.nextZoom(1.05, 1), 1.1);
  const pages = [{ width: 612, height: 792 }];
  close(g.fitScale(pages, 644, 2000, 'width'), 1);
  close(g.fitScale(pages, 2000, 824, 'page'), 1);
  assert.equal(g.fitScale([], 100, 100, 'width'), 1);
  assert.equal(g.clampZoom(100), 5);
});

test('computeReorder moves single and multiple pages', () => {
  assert.deepEqual(g.computeReorder(3, [2], 0), [2, 0, 1]);
  assert.deepEqual(g.computeReorder(3, [0], 3), [1, 2, 0]);
  assert.deepEqual(g.computeReorder(3, [0], 2), [1, 0, 2]);
  assert.deepEqual(g.computeReorder(5, [0, 3], 2), [1, 0, 3, 2, 4]);
  assert.deepEqual(g.computeReorder(4, [1], 1), [0, 1, 2, 3]);
  assert.deepEqual(g.computeReorder(4, [1], 2), [0, 1, 2, 3]);
  assert.ok(g.isIdentityOrder(g.computeReorder(4, [1], 2)));
  // result is always a permutation
  for (let t = 0; t <= 6; t++) assert.deepEqual([...g.computeReorder(6, [1, 4], t)].sort(), [0, 1, 2, 3, 4, 5]);
});

test('lineRect pads by stroke width', () => {
  assert.deepEqual(g.lineRect([10, 10], [20, 10], 1), [6, 6, 24, 14]);
  assert.deepEqual(g.lineRect([10, 10], [20, 10], 3), [1, 1, 29, 19]);
});

test('imagePlacementRect keeps aspect and never upscales', () => {
  assert.deepEqual(g.imagePlacementRect([100, 100], 400, 200), [0, 50, 200, 150]);
  assert.deepEqual(g.imagePlacementRect([100, 100], 10, 20), [95, 90, 105, 110]);
});

test('simplifyStroke drops near-duplicate points but keeps ends', () => {
  const pts = [[0, 0], [0.1, 0], [0.2, 0], [5, 5], [5.1, 5]];
  assert.deepEqual(g.simplifyStroke(pts), [[0, 0], [5, 5], [5.1, 5]]);
  assert.deepEqual(g.simplifyStroke([[1, 1]]), [[1, 1]]);
});

test('color conversions', () => {
  assert.deepEqual(g.hexToRgb('#ff0000'), [1, 0, 0]);
  assert.deepEqual(g.hexToRgb('#fff'), [1, 1, 1]);
  assert.equal(g.rgbToHex([1, 0.5, 0]), '#ff8000');
  assert.equal(g.rgbToHex(null), '#000000');
  assert.equal(g.rgbToHex(g.hexToRgb('#1d4ed8')), '#1d4ed8');
  assert.equal(g.rgbCss([1, 0, 0]), 'rgb(255,0,0)');
  assert.equal(g.rgbCss([0, 0, 1], 0.5), 'rgba(0,0,255,0.5)');
});

test('parsePageRange / formatPageRange', () => {
  assert.deepEqual(g.parsePageRange('1-3, 5, 8-', 9), [0, 1, 2, 4, 7, 8]);
  assert.deepEqual(g.parsePageRange('3-1', 5), [0, 1, 2]);
  assert.deepEqual(g.parsePageRange('7, 99', 8), [6]);
  assert.deepEqual(g.parsePageRange('-2', 5), [0, 1]);
  assert.throws(() => g.parsePageRange('abc', 5), /Invalid page range/);
  assert.equal(g.formatPageRange([0, 1, 2, 4, 7, 8]), '1-3, 5, 8-9');
  assert.equal(g.formatPageRange([3]), '4');
});

test('baseName strips extension', () => {
  assert.equal(g.baseName('report.final.pdf'), 'report.final');
  assert.equal(g.baseName(''), 'document');
});
