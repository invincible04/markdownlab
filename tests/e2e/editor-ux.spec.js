// Editor surfaces: find/replace, palette, TOC, examples menu, keyboard shortcuts.

import { test, expect } from '@playwright/test';
import { gotoAppClean, setEditor } from './helpers.js';

test.describe('Editor UX', () => {
  test('Cmd/Ctrl+F opens the find bar', async ({ page }) => {
    await gotoAppClean(page);
    await page.locator('#editor').click();
    await page.keyboard.press('ControlOrMeta+F');
    // Find bar is created lazily; its input receives focus.
    await expect(page.locator('.findbar, [role="search"]').first()).toBeVisible();
  });

  test('Cmd/Ctrl+P opens the command palette', async ({ page }) => {
    await gotoAppClean(page);
    await page.keyboard.press('ControlOrMeta+P');
    await expect(page.locator('#palette')).toBeVisible();
    await expect(page.locator('#palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#palette')).toBeHidden();
  });

  test('TOC builds from headings', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '# One\n\n## Two\n\n## Three\n\n### Four');
    await expect(page.locator('#toc-nav a')).toHaveCount(4);
    await expect(page.locator('#toc-nav')).toContainText('Two');
  });

  test('examples menu loads the Mermaid example', async ({ page }) => {
    await gotoAppClean(page);
    // The examples menu is built dynamically. Click its trigger then the entry.
    const trigger = page.getByRole('button', { name: /example/i }).first();
    await trigger.click();
    await page.getByRole('menuitem', { name: /mermaid/i }).first().click();
    // Mermaid renders an <svg> inside .mermaid blocks after async processing.
    await expect(page.locator('#preview svg').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Cmd/Ctrl+Shift+B toggles the sidebar', async ({ page }) => {
    await gotoAppClean(page);
    const shell = page.locator('#shell');
    const before = await shell.getAttribute('data-sidebar');
    // Cmd+Shift+B is the sidebar toggle (Cmd+B is bold).
    await page.keyboard.press('ControlOrMeta+Shift+B');
    await page.waitForTimeout(200);
    const after = await shell.getAttribute('data-sidebar');
    expect(after).not.toBe(before);
    await expect(page.locator('#sidebar')).toBeAttached();
  });

  test('? opens the shortcuts overlay', async ({ page }) => {
    await gotoAppClean(page);
    await page.locator('#preview').click();
    await page.keyboard.press('?');
    await expect(page.locator('#shortcuts-modal, [aria-label*="shortcut" i]').first()).toBeVisible();
  });
});
