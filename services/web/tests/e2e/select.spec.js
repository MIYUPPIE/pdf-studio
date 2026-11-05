import { test, expect } from '@playwright/test';
import { openDoc, annots, drag, clickAt, tool, until, info } from './helpers.js';

test('select, move, resize, nudge, delete, undo, redo', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'rect');
  await drag(page, 0, [100, 300], [200, 380]);
  await until(async () => (await annots(page)).length === 1);
  await tool(page, 'select');

  await clickAt(page, 0, 150, 340);
  const box = page.locator('.sel-box');
  await expect(box).toHaveAttribute('data-annot-type', 'Square');
  await expect(page.locator('#props h2')).toHaveText('Square');

  // move by (+50, +20)
  await drag(page, 0, [150, 340], [200, 360]);
  await until(async () => Math.abs((await annots(page))[0].rect[0] - 150) < 1.5);
  expect((await annots(page))[0].rect[1]).toBeCloseTo(320, 0);

  // resize via SE handle
  const h = page.locator('.sel-box .handle[data-h="se"]');
  const hb = await h.boundingBox();
  await page.mouse.move(hb.x + 5, hb.y + 5);
  await page.mouse.down();
  await page.mouse.move(hb.x + 45, hb.y + 25, { steps: 5 });
  await page.mouse.up();
  await until(async () => (await annots(page))[0].rect[2] > 260);

  // nudge with arrow keys
  const x0 = (await annots(page))[0].rect[0];
  await page.keyboard.press('Shift+ArrowRight');
  await until(async () => Math.abs((await annots(page))[0].rect[0] - (x0 + 10)) < 0.5);

  // property change from panel
  await page.locator('#props [data-swatches="color"] [data-color="#1d4ed8"]').click();
  await until(async () => (await annots(page))[0].color[2] > 0.8);

  // delete, undo, redo
  await page.keyboard.press('Delete');
  await until(async () => (await annots(page)).length === 0);
  expect((await info(page)).canUndo).toBe(true);
  await page.keyboard.press('Control+z');
  await until(async () => (await annots(page)).length === 1);
  await page.click('#redoBtn');
  await until(async () => (await annots(page)).length === 0);
  await page.keyboard.press('Control+Shift+Z'); // nothing to redo: no crash
  await page.keyboard.press('Control+y');
  await expect(page.locator('.toast.error')).toHaveCount(0);
});

test('double-click a text box edits its contents', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'text');
  await clickAt(page, 0, 100, 300);
  await page.locator('.text-editor').fill('First');
  await page.locator('.text-editor').press('Enter');
  await until(async () => (await annots(page)).length === 1);
  await page.keyboard.press('Escape');
  await clickAt(page, 0, 500, 700);  // deselect
  await expect(page.locator('.sel-box')).toHaveCount(0);
  const a = (await annots(page))[0];
  await clickAt(page, 0, a.rect[0] + 5, a.rect[1] + 5, { clickCount: 2 });
  const ed = page.locator('.text-editor');
  await expect(ed).toHaveValue('First');
  await ed.fill('Second');
  await ed.press('Enter');
  await until(async () => (await annots(page))[0].contents === 'Second');
});

test('escape deselects then returns to select tool', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'draw');
  await page.keyboard.press('Escape');
  await expect(page.locator('#toolbar [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('r');
  await expect(page.locator('#toolbar [data-tool="rect"]')).toHaveAttribute('aria-pressed', 'true');
});

// ---- Regression: "one can't modify a text after writing or anything after creating"
test('a new text box is selected right away and one more click edits it', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'text');
  await clickAt(page, 0, 100, 300);
  await page.locator('.text-editor').fill('Draft');
  await page.locator('.text-editor').press('Enter');
  await until(async () => (await annots(page)).length === 1);
  await expect(page.locator('#toolbar [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sel-box')).toBeVisible();
  await expect(page.locator('.sel-actions [data-act="edit"]')).toBeVisible();
  const a = (await annots(page))[0];
  await clickAt(page, 0, a.rect[0] + 5, a.rect[1] + 5);
  await expect(page.locator('.text-editor')).toHaveValue('Draft');
  await page.locator('.text-editor').fill('Final');
  await page.locator('.text-editor').press('Enter');
  await until(async () => (await annots(page))[0].contents === 'Final');
  expect((await annots(page)).length).toBe(1);
});

test('clicking existing added text with the Text tool edits it instead of adding a new box', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'text');
  await clickAt(page, 0, 100, 300);
  await page.locator('.text-editor').fill('Keep me');
  await page.locator('.text-editor').press('Enter');
  await until(async () => (await annots(page)).length === 1);
  await tool(page, 'text');
  const a = (await annots(page))[0];
  await clickAt(page, 0, a.rect[0] + 5, a.rect[1] + 5);
  await expect(page.locator('.text-editor')).toHaveValue('Keep me');
  await page.locator('.text-editor').press('Escape');
  expect((await annots(page)).length).toBe(1);
});

test('Edit text tool also edits text you added', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'text');
  await clickAt(page, 0, 300, 650);
  await page.locator('.text-editor').fill('Added');
  await page.locator('.text-editor').press('Enter');
  await until(async () => (await annots(page)).length === 1);
  await tool(page, 'edittext');
  const a = (await annots(page))[0];
  await clickAt(page, 0, a.rect[0] + 5, a.rect[1] + 5);
  await expect(page.locator('.text-editor')).toHaveValue('Added');
});

test('a new shape is selected; clicking another shape with a shape tool selects it, drag moves it', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'rect');
  await drag(page, 0, [100, 300], [200, 380]);
  await until(async () => (await annots(page)).length === 1);
  await expect(page.locator('#toolbar [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sel-box')).toBeVisible();
  await tool(page, 'ellipse');
  await drag(page, 0, [150, 340], [250, 420]);  // starts on the rectangle: moves it, no new ellipse
  await until(async () => (await annots(page))[0].rect[0] > 140);
  expect((await annots(page)).length).toBe(1);
});

test('selection action bar: duplicate and delete', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'rect');
  await drag(page, 0, [100, 300], [200, 380]);
  await until(async () => (await annots(page)).length === 1);
  await page.click('.sel-actions [data-act="duplicate"]');
  await until(async () => (await annots(page)).length === 2);
  const [a, b] = (await annots(page)).sort((x, y) => x.rect[0] - y.rect[0]);
  expect(b.rect[0] - a.rect[0]).toBeCloseTo(14, 0);
  await page.click('.sel-actions [data-act="delete"]');
  await until(async () => (await annots(page)).length === 1);
});
