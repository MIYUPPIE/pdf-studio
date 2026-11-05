import { test, expect } from '@playwright/test';
import { openDoc, fields, drag, tool, until, info } from './helpers.js';

test('fill text, checkbox and dropdown fields', async ({ page }) => {
  await openDoc(page);
  await page.evaluate(() => window.__app.viewer.scrollToPage(0, 560));
  const name = page.locator('.field[data-field-name="full_name"] input');
  await name.fill('Ada Lovelace');
  await name.press('Enter');
  await until(async () => (await fields(page)).find((f) => f.name === 'full_name').value === 'Ada Lovelace');
  await page.locator('.field[data-field-name="agree"] input').check();
  await until(async () => (await fields(page)).find((f) => f.name === 'agree').checked);
  await page.locator('.field[data-field-name="country"] select').selectOption('Kenya');
  await until(async () => (await fields(page)).find((f) => f.name === 'country').value === 'Kenya');
  expect((await info(page)).canUndo).toBe(true);
});

test('create a text field and a dropdown', async ({ page }) => {
  await openDoc(page, { extra: '%MOCKNOFORMS' });
  expect((await info(page)).hasForms).toBe(false);
  await tool(page, 'form');
  await page.locator('#props [data-seg="mode"] [data-val="text"]').click();
  await drag(page, 0, [100, 300], [300, 322]);
  await page.locator('#modal input[name=name]').fill('email');
  await page.locator('#modal [data-ok]').click();
  await until(async () => (await fields(page)).some((f) => f.name === 'email' && f.type === 'text'));
  await page.locator('#props [data-seg="mode"] [data-val="combo"]').click();
  await drag(page, 0, [100, 350], [250, 372]);
  await page.locator('#modal input[name=name]').fill('size');
  await page.locator('#modal textarea[name=options]').fill('S\nM\nL');
  await page.locator('#modal [data-ok]').click();
  await until(async () => { const f = (await fields(page)).find((x) => x.name === 'size'); return f && f.options.join() === 'S,M,L'; });
  await expect(page.locator('.field[data-field-name="email"] input')).toBeVisible();
  // delete it in form mode
  await page.locator('.field[data-field-name="email"] .del').click();
  await until(async () => !(await fields(page)).some((f) => f.name === 'email'));
});
