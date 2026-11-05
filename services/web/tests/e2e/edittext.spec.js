import { test, expect } from '@playwright/test';
import { openDoc, lines, clickAt, tool, until } from './helpers.js';

test('edit existing line of text', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'edittext');
  await expect(page.locator('.page').first().locator('.text-line')).toHaveCount(5);
  await clickAt(page, 0, 120, 135);
  const ed = page.locator('.text-editor');
  await expect(ed).toHaveValue('The quick brown fox jumps over the lazy dog.');
  await ed.fill('The quick red fox jumps over the lazy cat.');
  await ed.press('Enter');
  await until(async () => (await lines(page)).includes('The quick red fox jumps over the lazy cat.'));
  expect(await lines(page)).not.toContain('The quick brown fox jumps over the lazy dog.');
  // line boxes refreshed after re-render
  await expect(page.locator('.page').first().locator('.text-line')).toHaveCount(5);
});

test('escape cancels text edit without changes', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'edittext');
  await clickAt(page, 0, 120, 160);
  const ed = page.locator('.text-editor');
  await ed.fill('changed');
  await ed.press('Escape');
  await expect(ed).toHaveCount(0);
  expect(await lines(page)).toContain('Lorem ipsum dolor sit amet, consectetur adipiscing elit.');
  await expect(page.locator('#undoBtn')).toBeDisabled();
});

test('shift+enter makes multi-line replacement', async ({ page }) => {
  await openDoc(page);
  await tool(page, 'edittext');
  await clickAt(page, 0, 120, 160);
  const ed = page.locator('.text-editor');
  await ed.fill('');
  await ed.type('Line A');
  await ed.press('Shift+Enter');
  await ed.type('Line B');
  await ed.press('Enter');
  await until(async () => { const l = await lines(page); return l.includes('Line A') && l.includes('Line B'); });
});
