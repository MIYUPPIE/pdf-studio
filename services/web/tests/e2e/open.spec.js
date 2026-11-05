import { test, expect } from '@playwright/test';
import { openDoc, PDF, info } from './helpers.js';

test('landing page shows drop zone and no toolbar', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await expect(page.locator('#dropZone')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#downloadBtn')).toBeDisabled();
});

test('open a file: pages and thumbnails render', async ({ page }) => {
  await openDoc(page, { pages: 4 });
  await expect(page.locator('#pageCount')).toHaveText('4');
  await expect(page.locator('.thumb[data-rendered="1"]').first()).toBeVisible();
  await expect(page.locator('#fileName')).toContainText('test.pdf');
  const box = await page.locator('.page canvas.pg').first().evaluate((c) => ({ w: c.width, cssW: c.getBoundingClientRect().width }));
  expect(box.w).toBeGreaterThanOrEqual(Math.floor(box.cssW)); // HiDPI-or-better backing store
});

test('password protected file prompts, rejects wrong password, accepts right one', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.setInputFiles('#fileInput', { name: 'locked.pdf', mimeType: 'application/pdf', buffer: PDF(2, '%MOCKLOCKED') });
  const dlg = page.locator('#modal');
  await expect(dlg).toContainText('Password required');
  await dlg.locator('input[name=password]').fill('nope');
  await dlg.locator('[data-ok]').click();
  await expect(dlg.locator('.error-text')).toContainText('Incorrect password');
  await dlg.locator('input[name=password]').fill('secret');
  await dlg.locator('[data-ok]').click();
  await expect(page.locator('.thumb')).toHaveCount(2);
  expect((await info(page)).encrypted).toBe(true);
});

test('unrecognised file shows an error toast', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.setInputFiles('#fileInput', { name: 'notes.xyz', mimeType: 'application/octet-stream', buffer: Buffer.from('hello') });
  await expect(page.locator('.toast.error')).toContainText('cannot recognize');
  await expect(page.locator('#dropZone')).toBeVisible();
});

test('images are accepted (engine converts to PDF) and named .pdf', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.setInputFiles('#fileInput', { name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from('PNGDATA') });
  await expect(page.locator('.thumb')).toHaveCount(1);
  await expect(page.locator('#fileName')).toContainText('scan.pdf');
});
