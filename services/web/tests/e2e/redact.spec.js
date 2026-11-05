import { test, expect } from '@playwright/test';
import { openDoc, lines, drag, tool, until } from './helpers.js';

test('mark, remove mark, apply redactions permanently', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'redact');
  await drag(page, 0, [70, 175], [400, 192]); // over the invoice line
  await expect(page.locator('.redact-pending')).toHaveCount(1);
  await expect(page.locator('#redactBar')).toBeVisible();
  await drag(page, 0, [70, 128], [400, 145]);
  await expect(page.locator('.redact-pending')).toHaveCount(2);
  await page.locator('.redact-pending button').nth(1).click();
  await expect(page.locator('.redact-pending')).toHaveCount(1);
  // nothing removed yet
  expect((await lines(page)).some((l) => l.startsWith('Invoice'))).toBe(true);
  await page.click('#redactApply');
  await expect(page.locator('#modal')).toContainText('permanently');
  await page.locator('#modal [data-ok]').click();
  await until(async () => !(await lines(page)).some((l) => l.startsWith('Invoice')));
  expect(await lines(page)).toContain('The quick brown fox jumps over the lazy dog.');
  await expect(page.locator('.redact-pending')).toHaveCount(0);
  await expect(page.locator('#redactBar')).toBeHidden();
});

test('cancel redaction confirm keeps content', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'redact');
  await drag(page, 0, [70, 175], [400, 192]);
  await page.click('#redactApply');
  await page.locator('#modal [data-cancel]').click();
  expect((await lines(page)).some((l) => l.startsWith('Invoice'))).toBe(true);
});
