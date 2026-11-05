// Shared e2e helpers (mock engine).
import { expect } from '@playwright/test';

export const PDF = (pages = 3, extra = '') => Buffer.from(`%PDF-1.7\n%MOCKPAGES ${pages}\n${extra}\n`);

export async function openDoc(page, { pages = 3, name = 'test.pdf', extra = '' } = {}) {
  await page.goto('/index.html?mock=1');
  await page.setInputFiles('#fileInput', { name, mimeType: 'application/pdf', buffer: PDF(pages, extra) });
  await expect(page.locator('.page').first()).toHaveAttribute('data-rendered', '1');
  await expect(page.locator('.thumb')).toHaveCount(pages);
}

/** Call the engine directly (bypasses UI) for assertions. */
export async function engine(page, method, args = {}) {
  return page.evaluate(async ([m, a]) => {
    const app = window.__app;
    const { result } = await app.client.call(app.state.docId, m, a);
    return result;
  }, [method, args]);
}

export const annots = async (page, i = 0) => (await engine(page, 'listAnnotations', { page: i })).annots;
export const fields = async (page, i = 0) => (await engine(page, 'listFields', { page: i })).fields;
export const lines = async (page, i = 0) => (await engine(page, 'textLayout', { page: i })).blocks.flatMap((b) => b.lines.map((l) => l.text));
export const info = (page) => engine(page, 'info');

/** Screen coordinates of a page-space point on page `i`. */
export async function screenPt(page, i, x, y) {
  return page.evaluate(([i, x, y]) => {
    const v = window.__app.viewer.views[i];
    const r = v.overlay.getBoundingClientRect();
    const s = window.__app.state.scale;
    return { x: r.left + x * s, y: r.top + y * s };
  }, [i, x, y]);
}

export async function scrollIntoPage(page, i, y) {
  await page.evaluate(([i, y]) => window.__app.viewer.scrollToPage(i, y - 100), [i, y]);
  await page.waitForTimeout(50);
}

export async function drag(page, i, from, to, steps = 8) {
  await scrollIntoPage(page, i, Math.min(from[1], to[1]));
  const a = await screenPt(page, i, ...from);
  const b = await screenPt(page, i, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

export async function clickAt(page, i, x, y, opts = {}) {
  await scrollIntoPage(page, i, y);
  const a = await screenPt(page, i, x, y);
  await page.mouse.click(a.x, a.y, opts);
}

export async function tool(page, name) {
  await page.click(`#toolbar [data-tool="${name}"]`);
  await expect(page.locator(`#toolbar [data-tool="${name}"]`)).toHaveAttribute('aria-pressed', 'true');
}

/** Wait until an engine-side predicate holds. */
export async function until(fn, timeout = 5000) {
  await expect.poll(fn, { timeout }).toBeTruthy();
}

// 1x1 red PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
