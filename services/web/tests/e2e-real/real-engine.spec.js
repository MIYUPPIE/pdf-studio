// End-to-end against the REAL C++/WebAssembly engine (no mock).
// Requires `make wasm` (services/web/engine/pdfengine.{js,wasm} + fonts/).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lines, clickAt, tool, until, drag, engine, info } from '../e2e/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.join(here, '../../engine/pdfengine.js');
test.skip(!fs.existsSync(enginePath), 'wasm engine not built (run `make wasm`)');

// Build a real PDF with the engine itself (in Node), so the fixture is deterministic.
async function makePdf() {
  const { default: create } = await import(enginePath);
  const M = await create();
  const d = new M.Document();
  const call = (m, a = {}, b = null) => {
    const r = JSON.parse(d.call(m, JSON.stringify(a), b));
    if (!r.ok) throw new Error(`${m}: ${r.error.message}`);
    return r.result;
  };
  call('create', { pages: 2, pageSize: 'Letter' });
  call('addText', { page: 0, x: 72, y: 100, text: 'Quarterly report 2026', size: 24 });
  call('addText', { page: 0, x: 72, y: 140, text: 'Revenue grew by twelve percent.', size: 12 });
  call('addText', { page: 1, x: 72, y: 100, text: 'Second page', size: 18 });
  call('save', {});
  const bytes = Buffer.from(d.takeBytes());
  d.delete();
  return bytes;
}
let PDF_BYTES;
test.beforeAll(async () => { PDF_BYTES = await makePdf(); });

async function openReal(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/index.html');
  await page.setInputFiles('#fileInput', { name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES });
  await expect(page.locator('.thumb')).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator('.page').first()).toHaveAttribute('data-rendered', '1');
  return errors;
}

test('opens and renders a real PDF with the wasm engine', async ({ page }) => {
  const errors = await openReal(page);
  expect((await engine(page, 'version')).mupdf).toBe('1.28.6');
  expect(await lines(page)).toContain('Quarterly report 2026');
  await expect(page.locator('.toast.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('edit existing text through the UI, then download and verify the file', async ({ page }) => {
  await openReal(page);
  await tool(page, 'edittext');
  await expect(page.locator('.page').first().locator('.text-line').first()).toBeVisible();
  await clickAt(page, 0, 120, 132);
  const ed = page.locator('.text-editor');
  await expect(ed).toHaveValue('Revenue grew by twelve percent.');
  await ed.fill('Revenue grew by fifteen percent.');
  await ed.press('Enter');
  await until(async () => (await lines(page)).includes('Revenue grew by fifteen percent.'));
  expect(await lines(page)).not.toContain('Revenue grew by twelve percent.');

  await page.click('#downloadBtn');
  const dl = page.waitForEvent('download');
  await page.locator('#modal [data-ok]').click();
  const file = await (await dl).path();
  const saved = fs.readFileSync(file);
  expect(saved.subarray(0, 5).toString()).toBe('%PDF-');

  // Re-open the downloaded file in a fresh engine and check the edit is really in it.
  const { default: create } = await import(enginePath);
  const M = await create();
  const d = new M.Document();
  JSON.parse(d.call('open', JSON.stringify({ name: 'x.pdf' }), new Uint8Array(saved)));
  const tl = JSON.parse(d.call('textLayout', JSON.stringify({ page: 0 }), null)).result;
  const text = tl.blocks.flatMap((b) => b.lines.map((l) => l.text));
  expect(text).toContain('Revenue grew by fifteen percent.');
  d.delete();
});

test('Yoruba text edit loads fallback fonts in the worker', async ({ page }) => {
  await openReal(page);
  const fontRequests = [];
  page.on('request', (r) => { if (r.url().includes('/engine/fonts/')) fontRequests.push(r.url()); });
  await tool(page, 'edittext');
  await clickAt(page, 0, 120, 132);
  const ed = page.locator('.text-editor');
  await ed.fill('Ẹ ṣé púpọ̀ fún ìrànlọ́wọ́');
  await ed.press('Enter');
  await until(async () => (await lines(page)).some((l) => l.normalize('NFC').includes('ìrànlọ́wọ́'.normalize('NFC'))));
  expect(fontRequests.some((u) => u.endsWith('NotoSerif-Regular.otf'))).toBe(true);
});

test('draw a rectangle annotation, undo and redo', async ({ page }) => {
  await openReal(page);
  await tool(page, 'rect');
  await drag(page, 0, [100, 300], [220, 380]);
  await until(async () => (await engine(page, 'listAnnotations', { page: 0 })).annots.some((a) => a.type === 'Square'));
  await page.click('#undoBtn');
  await until(async () => (await engine(page, 'listAnnotations', { page: 0 })).annots.length === 0);
  await page.click('#redoBtn');
  await until(async () => (await engine(page, 'listAnnotations', { page: 0 })).annots.length === 1);
});

test('convert and combine HTML + Markdown + text into one PDF', async ({ page }) => {
  await page.goto('/index.html');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#convertBtn');
  await (await chooser).setFiles([
    { name: 'invoice.html', mimeType: 'text/html', buffer: Buffer.from('<h1>Invoice 1042</h1><p>Total: 5,000</p>') },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Meeting notes\n\n- ship it') },
    { name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text line') },
  ]);
  await page.click('dialog [data-ok]');
  await expect(page.locator('.thumb')).toHaveCount(3, { timeout: 20000 });
  expect((await info(page)).pageCount).toBe(3);
  expect(await lines(page, 0)).toContain('Invoice 1042');
  expect(await lines(page, 1)).toContain('Meeting notes');
  expect(await lines(page, 2)).toContain('plain text line');
  await expect(page.locator('#fileName')).toContainText('Combined.pdf');
});

test('page operations with the real engine: rotate, delete, undo', async ({ page }) => {
  await openReal(page);
  await page.evaluate(() => window.__app.callStructural('rotatePages', { pages: [1], degrees: 90 }));
  expect((await info(page)).pages[1].rotation).toBe(90);
  await page.evaluate(() => window.__app.callStructural('deletePages', { pages: [0] }));
  expect((await info(page)).pageCount).toBe(1);
  await page.click('#undoBtn');
  await expect.poll(async () => (await info(page)).pageCount).toBe(2);
  await expect(page.locator('.thumb')).toHaveCount(2);
});
