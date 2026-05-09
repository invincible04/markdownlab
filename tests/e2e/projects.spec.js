// Tabs and projects: new file, rename, close, autosave across tabs.

import { test, expect } from '@playwright/test';
import { gotoAppClean, setEditor } from './helpers.js';

test.describe('Projects and tabs', () => {
  test('creates a new file via the + tab button', async ({ page }) => {
    await gotoAppClean(page);
    const before = await page.locator('#tabs-scroll .tab').count();
    await page.locator('#btn-tabs-add').click();
    await expect(page.locator('#tabs-scroll .tab')).toHaveCount(before + 1);
  });

  test('each tab keeps its own content', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '# File A body');

    await page.locator('#btn-tabs-add').click();
    await page.waitForTimeout(300);
    await setEditor(page, '# File B body');
    await expect(page.locator('#preview')).toContainText('File B body');

    // Switch to first tab.
    await page.locator('#tabs-scroll .tab').first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('#preview')).toContainText('File A body');
  });

  test('closing last tab produces a clean empty state', async ({ page }) => {
    await gotoAppClean(page);
    const closers = page.locator('#tabs-scroll .tab__close');
    const n = await closers.count();
    for (let i = 0; i < n; i++) {
      // Always close the first tab since indexes shift.
      await page.locator('#tabs-scroll .tab__close').first().click();
      await page.waitForTimeout(100);
    }
    await expect(page.locator('#tabs-scroll .tab')).toHaveCount(0);
  });
});
