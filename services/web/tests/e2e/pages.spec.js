import { test, expect } from '@playwright/test';
import { openDoc, info, lines, until } from './helpers.js';

const firstLine = async (page, i) => (await lines(page, i))[0];

test('rotate selected page from sidebar', async ({ page }) => {
  await openDoc(page);
  await page.locator('.thumb').nth(1).click();
  await page.click('#thumbRotateR');
  await until(async () => (await info(page)).pages[1].rotation === 90);
  const p = (await info(page)).pages[1];
  expect(p.width).toBe(792);
  await expect(page.locator('.page').nth(1)).toHaveCSS('width', /.+/);
  await page.click('#thumbRotateL');
  await until(async () => (await info(page)).pages[1].rotation === 0);
});

test('delete page via context menu with confirmation, then undo', async ({ page }) => {
  await openDoc(page);
  await page.locator('.thumb').nth(0).click({ button: 'right' });
  await page.locator('#ctxMenu button', { hasText: 'Delete page 1' }).click();
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('.thumb')).toHaveCount(2);
  expect(await firstLine(page, 0)).toBe('Mock document page 2');
  await page.click('#undoBtn');
  await expect(page.locator('.thumb')).toHaveCount(3);
  expect(await firstLine(page, 0)).toBe('Mock document page 1');
});

test('reorder pages by dragging thumbnails', async ({ page }) => {
  await openDoc(page);
  await page.locator('.thumb').nth(2).dragTo(page.locator('.thumb').nth(0), { targetPosition: { x: 20, y: 5 } });
  await until(async () => (await firstLine(page, 0)) === 'Mock document page 3');
  expect(await firstLine(page, 1)).toBe('Mock document page 1');
  expect(await firstLine(page, 2)).toBe('Mock document page 2');
});

test('multi-select pages with ctrl-click and rotate both', async ({ page }) => {
  await openDoc(page);
  await page.locator('.thumb').nth(0).click({ modifiers: ['Control'] });
  await page.locator('.thumb').nth(2).click({ modifiers: ['Control'] });
  await expect(page.locator('.thumb.selected')).toHaveCount(2);
  await page.click('#thumbRotateR');
  await until(async () => { const p = (await info(page)).pages; return p[0].rotation === 90 && p[2].rotation === 90 && p[1].rotation === 0; });
});

test('insert blank page and duplicate', async ({ page }) => {
  await openDoc(page);
  await page.locator('.thumb').nth(0).click({ button: 'right' });
  await page.locator('#ctxMenu button', { hasText: 'Insert blank' }).click();
  await expect(page.locator('.thumb')).toHaveCount(4);
  expect(await lines(page, 1)).toEqual([]);
  await page.locator('.thumb').nth(0).click({ button: 'right' });
  await page.locator('#ctxMenu button', { hasText: 'Duplicate' }).click();
  await expect(page.locator('.thumb')).toHaveCount(5);
  expect(await firstLine(page, 1)).toBe('Mock document page 1');
});

test('cannot delete every page', async ({ page }) => {
  await openDoc(page, { pages: 1 });
  await page.click('#thumbDelete');
  await expect(page.locator('.toast.error')).toContainText('at least one page');
});
