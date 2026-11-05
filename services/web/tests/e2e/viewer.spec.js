import { test, expect } from '@playwright/test';
import { openDoc } from './helpers.js';

const scale = (page) => page.evaluate(() => window.__app.state.scale);

test('zoom in / out / select / ctrl shortcuts', async ({ page }) => {
  await openDoc(page);
  const s0 = await scale(page);
  await page.click('#zoomInBtn');
  expect(await scale(page)).toBeGreaterThan(s0);
  await page.selectOption('#zoomSelect', '0.5');
  expect(await scale(page)).toBeCloseTo(0.5);
  await page.click('#zoomOutBtn');
  expect(await scale(page)).toBeLessThan(0.5);
  await page.locator('#viewer').focus();
  await page.keyboard.press('Control+0');
  expect(await scale(page)).toBeCloseTo(1);
  await page.selectOption('#zoomSelect', 'page');
  const sp = await scale(page);
  const vh = await page.locator('#viewer').evaluate((e) => e.clientHeight);
  expect(792 * sp).toBeLessThanOrEqual(vh);
  // canvases re-render at the new scale
  await expect(page.locator('.page').first()).toHaveAttribute('data-rendered', '1');
});

test('page navigation input scrolls to page', async ({ page }) => {
  await openDoc(page, { pages: 5 });
  await page.fill('#pageInput', '4');
  await page.press('#pageInput', 'Enter');
  await expect.poll(() => page.evaluate(() => window.__app.state.currentPage)).toBe(3);
  await expect(page.locator('.thumb.current')).toHaveAttribute('data-page', '3');
});

test('search finds hits across pages, next/prev cycles', async ({ page }) => {
  await openDoc(page, { pages: 3 });
  await page.keyboard.press('Control+f');
  await expect(page.locator('#searchBar')).toBeVisible();
  await page.fill('#searchInput', 'invoice');
  await page.press('#searchInput', 'Enter');
  await expect(page.locator('#searchCount')).toHaveText('1 of 3');
  await expect(page.locator('.search-hit.active')).toHaveCount(1);
  await page.click('#searchNext');
  await expect(page.locator('#searchCount')).toHaveText('2 of 3');
  await page.click('#searchPrev');
  await page.click('#searchPrev');
  await expect(page.locator('#searchCount')).toHaveText('3 of 3');
  await page.fill('#searchInput', 'zzzz-not-there');
  await expect(page.locator('#searchCount')).toHaveText('No matches');
  await page.press('#searchInput', 'Escape');
  await expect(page.locator('#searchBar')).toBeHidden();
});

test('Enter right after typing still jumps to the first hit (regression: debounce cancelled it)', async ({ page }) => {
  await openDoc(page, { pages: 3 });
  await page.keyboard.press('Control+f');
  await page.locator('#searchInput').pressSequentially('invoice', { delay: 10 });
  await page.press('#searchInput', 'Enter');
  await page.waitForTimeout(400); // past the 250ms as-you-type debounce
  await expect(page.locator('#searchCount')).toHaveText('1 of 3');
});
