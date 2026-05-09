// Smoke tests — verifies the app boots, renders, persists, and wires up
// its core surfaces. These run quickly and catch regressions across the
// whole pipeline (marked → DOMPurify → preview diff → stats).

import { test, expect } from '@playwright/test';
import { gotoAppClean, gotoApp, setEditor, expectPreviewContains } from './helpers.js';

test.describe('Smoke', () => {
  test('app boots with a welcome file seeded', async ({ page }) => {
    await gotoAppClean(page);
    await expect(page.locator('#editor')).toBeVisible();
    // First-run seed creates a "welcome.md" file containing the welcome
    // tour. Both editor and preview should reflect that content.
    await expect(page.locator('#preview')).toContainText('Welcome to MarkdownLab');
    await expect(page.locator('#tabs-scroll .tab')).toHaveCount(1);
  });

  test('typing markdown updates the preview live', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '# My heading\n\nHello *world*');
    await expectPreviewContains(page, 'My heading');
    await expect(page.locator('#preview h1')).toContainText('My heading');
    await expect(page.locator('#preview em')).toContainText('world');
  });

  test('stats update as you type', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, 'one two three four five');
    await expect(page.locator('#stat-words')).toHaveText('5');
  });

  test('theme toggle switches data-theme', async ({ page }) => {
    await gotoAppClean(page);
    const initial = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.locator('#btn-theme').click();
    const next = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(next).not.toBe(initial);
  });

  test('reloading preserves editor content (autosave)', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '# Persisted header\n\npara');
    // Let autosave debounce fire.
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForFunction(() => {
      const ed = document.getElementById('editor');
      return ed && ed.value.includes('Persisted header');
    }, null, { timeout: 10_000 });
    await expect(page.locator('#preview')).toContainText('Persisted header');
  });
});
