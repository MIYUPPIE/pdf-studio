// Creating PDFs: blank documents and converting/combining any supported files.
import { test, expect } from '@playwright/test';
import { PDF, info, engine } from './helpers.js';

const file = (name, body = 'x') => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(body) });

test('file pickers accept every format the engine converts', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await expect(page.locator('#fileInput')).toHaveAttribute('accept', /\.docx/);
  const accept = await page.locator('#convertInput').getAttribute('accept');
  for (const ext of ['.pdf', '.docx', '.xlsx', '.pptx', '.html', '.md', '.txt', '.png']) expect(accept).toContain(ext);
});

test('create a blank PDF from the landing page', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.click('#newBlankBtn');
  await page.fill('dialog input[name=pages]', '3');
  await page.selectOption('dialog select[name=pageSize]', 'Letter');
  await page.click('dialog [data-ok]');
  await expect(page.locator('.thumb')).toHaveCount(3);
  const i = await info(page);
  expect(i.pageCount).toBe(3);
  expect(i.pages[0].width).toBe(612);
  await expect(page.locator('#fileName')).toContainText('Untitled.pdf');
});

test('blank PDF rejects an invalid page count', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.click('#newBlankBtn');
  await page.fill('dialog input[name=pages]', '0');
  await page.click('dialog [data-ok]');
  await expect(page.locator('dialog .error-text')).toContainText('between 1 and 1000');
});

test('convert a single Word file to PDF', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#convertBtn');
  await (await chooser).setFiles([file('report.docx')]);
  await expect(page.locator('dialog header')).toContainText('Convert report.docx to PDF');
  await page.click('dialog [data-ok]');
  await expect(page.locator('.thumb').first()).toBeVisible();
  await expect(page.locator('#fileName')).toContainText('report.pdf');
  await expect(page.locator('#fileName .dirty')).toBeVisible();
});

test('combine several files, reordered, into one PDF', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#convertBtn');
  await (await chooser).setFiles([
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF(2) },
    file('b.png'),
    file('c.xlsx'),
  ]);
  await expect(page.locator('dialog header')).toContainText('Combine 3 files');
  // Move c.xlsx to the top.
  await page.click('dialog li:nth-child(3) [data-move="-1"]');
  await page.click('dialog li:nth-child(2) [data-move="-1"]');
  await expect(page.locator('dialog li .name').first()).toHaveText('c.xlsx');
  await page.click('dialog [data-ok]');
  await expect(page.locator('.thumb')).toHaveCount(3 + 2 + 1);
  await expect(page.locator('#fileName')).toContainText('Combined.pdf');
  // One undo step per inserted file.
  expect((await info(page)).canUndo).toBe(true);
});

test('dropping several files on the landing page offers to combine them', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['%PDF-1.7\n%MOCKPAGES 1\n'], 'one.pdf', { type: 'application/pdf' }));
    d.items.add(new File(['x'], 'two.md'));
    return d;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect(page.locator('dialog header')).toContainText('Combine 2 files');
  await page.click('dialog [data-ok]');
  await expect(page.locator('.thumb')).toHaveCount(1 + 3);
});

test('document menu offers new and convert while a document is open', async ({ page }) => {
  await page.goto('/index.html?mock=1');
  await page.setInputFiles('#fileInput', { name: 't.pdf', mimeType: 'application/pdf', buffer: PDF(1) });
  await expect(page.locator('.thumb')).toHaveCount(1);
  await page.click('#docMenuBtn');
  await expect(page.locator('[data-action=newBlank]')).toBeVisible();
  await expect(page.locator('[data-action=convert]')).toBeVisible();
  await page.click('[data-action=newBlank]');
  await page.click('dialog [data-ok]');
  await expect(page.locator('.thumb')).toHaveCount(1);
  expect((await engine(page, 'info')).pages[0].width).toBe(595);
});
