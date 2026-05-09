// Shared helpers for the MarkdownLab E2E suite.
//
// Each test uses a fresh BrowserContext (the Playwright default), which
// isolates IndexedDB + localStorage per run. `gotoAppClean` additionally
// wipes storage before the first render so asserting "empty starting state"
// is stable even when reusing the dev server.

import { expect } from '@playwright/test';

/**
 * Navigate to `/`, blow away any persisted state from a previous run, then
 * reload so the app bootstraps onto a clean profile.
 *
 * Why the double cleanup: IndexedDB connections from the initial visit
 * can keep a deleteDatabase() request `blocked` until we close them. We
 * re-open + close the DB explicitly, then wait on the deletion's
 * `versionchange` event, then reload. Without this the seed logic sees
 * a half-populated DB on reload and silently skips seeding.
 *
 * @param {import('@playwright/test').Page} page
 */
/**
 * Navigate to `/` and wait for the app to seed its default welcome file.
 *
 * Each Playwright test runs in a fresh BrowserContext by default, so
 * IndexedDB + localStorage are already clean — we don't need to wipe
 * them. The `Clean` suffix is kept for API-clarity; "clean" here means
 * "known clean state after first-visit seed".
 *
 * @param {import('@playwright/test').Page} page
 */
export async function gotoAppClean(page) {
  await page.goto('/');
  await waitForAppReady(page);
  await waitForActiveFile(page);
}

/**
 * Go to the app without clearing storage. Use when testing persistence.
 * @param {import('@playwright/test').Page} page
 */
export async function gotoApp(page) {
  await page.goto('/');
  await waitForAppReady(page);
}

/**
 * Wait for the render pipeline to be ready — editor mounted, libs loaded,
 * status indicator idle.
 * @param {import('@playwright/test').Page} page
 */
export async function waitForAppReady(page) {
  await page.locator('#editor').waitFor({ state: 'attached' });
  // All CDN libs referenced by the app must be attached to window.
  await page.waitForFunction(
    () => !!(window.marked && window.DOMPurify && window.hljs && window.katex),
    null,
    { timeout: 10_000 }
  );
  // Give one tick for init() to attach listeners + first render.
  await page.waitForFunction(() => {
    const s = document.getElementById('status-dot');
    return s && s.dataset.status !== 'error';
  });
}

/**
 * Wait for the app's seed flow to finish — a tab is mounted in the tab bar
 * and the editor has the welcome content. Use after `gotoAppClean` to
 * guard against flaky DB-seed timing.
 * @param {import('@playwright/test').Page} page
 */
export async function waitForActiveFile(page) {
  await page.waitForFunction(() => {
    const t = document.querySelector('#tabs-scroll .tab');
    const ed = document.getElementById('editor');
    return !!(t && ed && ed.value.length > 0);
  }, null, { timeout: 10_000 });
}

/**
 * Replace the entire editor contents and wait for the debounced preview
 * to reflect the new text. The app debounces renders, so we poll preview
 * innerText against a predicate rather than asserting on a static value.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} md
 */
export async function setEditor(page, md) {
  const editor = page.locator('#editor');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  // Use fill rather than type for speed; render debounce still runs.
  await editor.fill(md);
  // Release any pending animation frames.
  await page.waitForTimeout(200);
}

/**
 * Wait for the preview pane to contain a given substring.
 * @param {import('@playwright/test').Page} page
 * @param {string} needle
 */
export async function expectPreviewContains(page, needle) {
  await expect(page.locator('#preview')).toContainText(needle, { timeout: 3_000 });
}
