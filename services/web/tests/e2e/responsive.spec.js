// Layout across devices: phone (390), tablet (820), desktop (1440).
import { test, expect } from '@playwright/test';
import { openDoc } from './helpers.js';

const noOverflow = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const onScreen = async (page, sel) => {
  const b = await page.locator(sel).boundingBox();
  const vw = page.viewportSize().width, vh = page.viewportSize().height;
  expect(b, sel).not.toBeNull();
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(vh + 0.5);
};

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('landing fits, actions reachable', async ({ page }) => {
    await page.goto('/index.html?mock=1');
    await noOverflow(page);
    await onScreen(page, '#openBtn');
    await onScreen(page, '#themeBtn');
  });

  test('editor: download, undo, search, menu and tools are all reachable; tools dock at the bottom', async ({ page }) => {
    await openDoc(page);
    await noOverflow(page);
    for (const sel of ['#downloadBtn', '#undoBtn', '#searchBtn', '#docMenuBtn', '#propsToggle', '#sidebarToggle', '#zoomSelect', '#pageInput']) await onScreen(page, sel);
    const tb = await page.locator('#toolbar').boundingBox();
    expect(tb.y + tb.height).toBeGreaterThan(844 - 2);  // bottom dock
    await expect(page.locator('#sidebar')).not.toBeInViewport();
    await expect(page.locator('#props')).not.toBeInViewport();
  });

  test('pages drawer opens, picking a page closes it', async ({ page }) => {
    await openDoc(page, { pages: 3 });
    await page.click('#sidebarToggle');
    await expect(page.locator('#sidebar')).toBeInViewport();
    await expect(page.locator('#scrim')).toBeVisible();
    await page.locator('.thumb').nth(2).click();
    await expect(page.locator('#scrim')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__app.state.currentPage)).toBe(2);
  });

  test('properties open as a bottom sheet and close from the backdrop', async ({ page }) => {
    await openDoc(page);
    await page.click('#propsToggle');
    const b = await page.locator('#props').boundingBox();
    await expect(page.locator('#props')).toBeInViewport();
    expect(b.y + b.height).toBeGreaterThan(840);
    await page.locator('#scrim').click({ position: { x: 200, y: 100 } });
    await expect(page.locator('#props')).not.toBeInViewport();
  });

  test('one finger scrolls the document in select mode, drawing tools capture touch', async ({ page }) => {
    await openDoc(page);
    const ta = () => page.locator('.overlay').first().evaluate((el) => getComputedStyle(el).touchAction);
    expect(await ta()).toContain('pan-y');
    await page.locator('#toolbar [data-tool="draw"]').click();
    expect(await ta()).toBe('none');
  });

  test('next / previous page buttons', async ({ page }) => {
    await openDoc(page, { pages: 3 });
    await page.click('#nextPageBtn');
    await expect.poll(() => page.evaluate(() => window.__app.state.currentPage)).toBe(1);
    await page.click('#prevPageBtn');
    await expect.poll(() => page.evaluate(() => window.__app.state.currentPage)).toBe(0);
  });
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 } });
  test('pages column visible, properties as a drawer', async ({ page }) => {
    await openDoc(page);
    await noOverflow(page);
    await expect(page.locator('#sidebar')).toBeInViewport();
    await expect(page.locator('#props')).not.toBeInViewport();
    await page.click('#propsToggle');
    await expect(page.locator('#props')).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(page.locator('#props')).not.toBeInViewport();
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('both panels collapse and the page refits wider', async ({ page }) => {
    await openDoc(page);
    const before = await page.evaluate(() => window.__app.state.scale);
    await page.click('#sidebarToggle');
    await page.click('#propsToggle');
    await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => page.evaluate(() => window.__app.state.scale)).toBeGreaterThan(before);
  });

  test('theme cycles auto → light → dark and is remembered', async ({ page }) => {
    await page.goto('/index.html?mock=1');
    await page.click('#themeBtn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.click('#themeBtn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
