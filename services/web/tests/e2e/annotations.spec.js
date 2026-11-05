import { test, expect } from '@playwright/test';
import { openDoc, annots, drag, clickAt, tool, until, PNG } from './helpers.js';

const types = async (page, i = 0) => (await annots(page, i)).map((a) => a.type);

test.beforeEach(async ({ page }) => { await openDoc(page); });

test('add text box (FreeText)', async ({ page }) => {
  await tool(page, 'text');
  await clickAt(page, 0, 100, 300);
  const ed = page.locator('.text-editor');
  await expect(ed).toBeFocused();
  await ed.fill('Hello PDF');
  await ed.press('Enter');
  await until(async () => (await annots(page)).some((a) => a.type === 'FreeText' && a.contents === 'Hello PDF'));
  const a = (await annots(page)).find((x) => x.type === 'FreeText');
  expect(a.fontSize).toBe(14);
  expect(a.rect[0]).toBeCloseTo(100, 0);
});

test('freehand draw creates Ink', async ({ page }) => {
  await tool(page, 'draw');
  await drag(page, 0, [100, 300], [220, 360], 12);
  await until(async () => (await types(page)).includes('Ink'));
  const ink = (await annots(page)).find((a) => a.type === 'Ink');
  expect(ink.ink[0].length).toBeGreaterThan(2);
});

for (const [t, type] of [['rect', 'Square'], ['ellipse', 'Circle']]) {
  test(`${t} creates ${type}`, async ({ page }) => {
    await tool(page, t);
    await drag(page, 0, [100, 300], [200, 380]);
    await until(async () => (await types(page)).includes(type));
    const a = (await annots(page)).find((x) => x.type === type);
    expect(a.rect[0]).toBeCloseTo(100, 0);
    expect(a.rect[3]).toBeCloseTo(380, 0);
  });
}

test('line and arrow create Line annotations with endings', async ({ page }) => {
  await tool(page, 'line');
  await drag(page, 0, [100, 300], [250, 300]);
  await tool(page, 'arrow');
  await drag(page, 0, [100, 400], [250, 450]);
  await until(async () => (await types(page)).filter((t) => t === 'Line').length === 2);
  const lines = (await annots(page)).filter((a) => a.type === 'Line');
  expect(lines[0].lineEnding).toEqual(['None', 'None']);
  expect(lines[1].lineEnding).toEqual(['None', 'OpenArrow']);
  expect(lines[1].points[1][0]).toBeCloseTo(250, 0);
});

for (const [t, type] of [['highlight', 'Highlight'], ['underline', 'Underline'], ['strike', 'StrikeOut']]) {
  test(`${t} text markup creates ${type} with quads`, async ({ page }) => {
    await tool(page, t);
    // drag across "The quick brown fox" line (baseline y=140)
    await drag(page, 0, [74, 135], [200, 135]);
    await until(async () => (await types(page)).includes(type));
    const a = (await annots(page)).find((x) => x.type === type);
    expect(a.quads.length).toBe(1);
    expect(a.quads[0]).toHaveLength(8);
  });
}

test('multi-line highlight produces one quad per line', async ({ page }) => {
  await tool(page, 'highlight');
  await drag(page, 0, [80, 135], [150, 183]);
  await until(async () => (await types(page)).includes('Highlight'));
  expect((await annots(page))[0].quads.length).toBe(3);
});

test('sticky note', async ({ page }) => {
  await tool(page, 'note');
  await clickAt(page, 0, 400, 300);
  await page.locator('#modal textarea').fill('Check this figure');
  await page.locator('#modal [data-ok]').click();
  await until(async () => (await annots(page)).some((a) => a.type === 'Text' && a.contents === 'Check this figure'));
});

test('image is placed as a movable Stamp', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.click('#toolbar [data-tool="image"]');
  await (await chooser).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await clickAt(page, 0, 300, 400);
  await until(async () => (await types(page)).includes('Stamp'));
  const a = (await annots(page)).find((x) => x.type === 'Stamp');
  expect(a.image).toBe(true);
  // tool returns to select with the new image selected
  await expect(page.locator('#toolbar [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sel-box')).toHaveAttribute('data-annot-type', 'Stamp');
});

test('drawn signature placed as Ink', async ({ page }) => {
  await page.click('#toolbar [data-tool="signature"]');
  const pad = page.locator('#modal .sig-pad');
  await expect(pad).toBeVisible();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 20, b.y + 60);
  await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 30, { steps: 6 });
  await page.mouse.move(b.x + 220, b.y + 90, { steps: 6 });
  await page.mouse.up();
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('#modal')).not.toBeVisible();  // typed signatures render asynchronously
  await clickAt(page, 0, 300, 500);
  await until(async () => (await types(page)).includes('Ink'));
  const ink = (await annots(page)).find((a) => a.type === 'Ink');
  expect(ink.ink[0].length).toBeGreaterThan(3);
  expect(ink.rect[2] - ink.rect[0]).toBeGreaterThan(100);
});

test('typed signature placed as image Stamp', async ({ page }) => {
  await page.click('#toolbar [data-tool="signature"]');
  await page.locator('#modal [data-tab="type"]').click();
  await page.locator('#modal input[name=typed]').fill('Olayemi Test');
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('#modal')).not.toBeVisible();  // typed signatures render asynchronously
  await clickAt(page, 0, 300, 500);
  await until(async () => (await types(page)).includes('Stamp'));
});

test('signature dialog validates empty pad', async ({ page }) => {
  await page.click('#toolbar [data-tool="signature"]');
  await page.locator('#modal [data-ok]').click();
  await expect(page.locator('#modal .error-text')).toContainText('Draw your signature');
});
