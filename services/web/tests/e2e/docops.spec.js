import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openDoc, PDF, info, until, engine } from './helpers.js';

async function menu(page, action) {
  await page.click('#docMenuBtn');
  await page.locator(`#docMenu [data-action="${action}"]`).click();
}

test('download saves a PDF with the original name and clears dirty flag', async ({ page }) => {
  await openDoc(page);
  await page.keyboard.press('r');
  await page.evaluate(() => window.__app.mutate('addAnnotation', { page: 0, type: 'Square', rect: [10, 10, 50, 50] }));
  await expect(page.locator('#fileName .dirty')).toBeVisible();
  await page.click('#downloadBtn');
  await page.locator('#modal input[name=flatten]').check();
  const dl = page.waitForEvent('download');
  await page.locator('#modal [data-ok]').click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe('test.pdf');
  const buf = fs.readFileSync(await d.path(), 'latin1');
  expect(buf.startsWith('%MOCKSTATE')).toBe(true);
  expect(JSON.parse(buf.slice(11)).saveOpts.flatten).toBe(true);
  await expect(page.locator('#fileName .dirty')).toHaveCount(0);
});

test('extract pages downloads a new PDF', async ({ page }) => {
  await openDoc(page, { pages: 5 });
  await menu(page, 'extract');
  await page.locator('#modal input[name=range]').fill('2-3');
  const dl = page.waitForEvent('download');
  await page.locator('#modal [data-ok]').click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe('test-pages-2-3.pdf');
  const st = JSON.parse(fs.readFileSync(await d.path(), 'latin1').slice(11));
  expect(st.pages.length).toBe(2);
});

test('split into one file per page', async ({ page }) => {
  await openDoc(page, { pages: 3 });
  await menu(page, 'extract');
  await page.locator('#modal input[name=range]').fill('1-2');
  await page.locator('#modal input[value=each]').check();
  const names = [];
  page.on('download', (d) => names.push(d.suggestedFilename()));
  await page.locator('#modal [data-ok]').click();
  await expect.poll(() => names.length).toBe(2);
  expect(names.sort()).toEqual(['test-page-1.pdf', 'test-page-2.pdf']);
});

test('invalid page range shows validation error', async ({ page }) => {
  await openDoc(page);
  await menu(page, 'extract');
  await page.locator('#modal input[name=range]').fill('abc');
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('#modal .error-text')).toContainText('Invalid page range');
});

test('merge another file at the end', async ({ page }) => {
  await openDoc(page, { pages: 2 });
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'merge');
  await (await chooser).setFiles({ name: 'other.pdf', mimeType: 'application/pdf', buffer: PDF(3) });
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('.thumb')).toHaveCount(5);
  expect((await info(page)).pageCount).toBe(5);
});

test('protect requires owner password and downloads encrypted file', async ({ page }) => {
  await openDoc(page);
  await menu(page, 'protect');
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('#modal .error-text')).toContainText('Owner password is required');
  await page.locator('#modal input[name=user]').fill('open1');
  await page.locator('#modal input[name=owner]').fill('own1');
  await page.locator('#modal input[name=owner2]').fill('own1');
  await page.locator('#modal input[name=edit]').check();
  const dl = page.waitForEvent('download');
  await page.locator('#modal [data-ok]').click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe('test-protected.pdf');
  const st = JSON.parse(fs.readFileSync(await d.path(), 'latin1').slice(11));
  expect(st.saveOpts.encrypt).toEqual({ ownerPassword: 'own1', userPassword: 'open1', permissions: { print: true, copy: true, edit: true, annotate: true, forms: true } });
});

test('compress downloads with image downsampling options', async ({ page }) => {
  await openDoc(page);
  await menu(page, 'compress');
  await page.locator('#modal select[name=dpi]').selectOption('72');
  const dl = page.waitForEvent('download');
  await page.locator('#modal [data-ok]').click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe('test-compressed.pdf');
  const st = JSON.parse(fs.readFileSync(await d.path(), 'latin1').slice(11));
  expect(st.saveOpts).toMatchObject({ compressImages: true, imageDpi: 72, garbage: 4 });
  await expect(page.locator('.toast.success')).toContainText('Compressed');
});

test('export page image', async ({ page }) => {
  await openDoc(page);
  await menu(page, 'exportImage');
  await page.locator('#modal input[name=page]').fill('2');
  const dl = page.waitForEvent('download');
  await page.locator('#modal [data-ok]').click();
  expect((await dl).suggestedFilename()).toBe('test-page-2.png');
});

test('metadata editor round-trips', async ({ page }) => {
  await openDoc(page);
  await menu(page, 'metadata');
  await page.locator('#modal input[name=title]').fill('Quarterly Report');
  await page.locator('#modal [data-ok]').click();
  await until(async () => (await engine(page, 'getMetadata')).title === 'Quarterly Report');
});

test('decrypt is disabled for unencrypted docs, works for encrypted', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.setInputFiles('#fileInput', { name: 'locked.pdf', mimeType: 'application/pdf', buffer: PDF(1, '%MOCKLOCKED') });
  await page.locator('#modal input[name=password]').fill('secret');
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('.thumb')).toHaveCount(1);
  await page.click('#docMenuBtn');
  await expect(page.locator('#docMenu [data-action="decrypt"]')).toBeEnabled();
  const dl = page.waitForEvent('download');
  await page.locator('#docMenu [data-action="decrypt"]').click();
  expect((await dl).suggestedFilename()).toBe('locked-unlocked.pdf');
});

test('unsaved changes trigger beforeunload guard', async ({ page }) => {
  await openDoc(page);
  await page.evaluate(() => window.__app.mutate('addAnnotation', { page: 0, type: 'Square', rect: [10, 10, 50, 50] }));
  const prevented = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  expect(prevented).toBe(true);
});
