// "Load from GitHub URL" feature. All GitHub network is mocked to keep the suite hermetic.

import { test, expect } from '@playwright/test';
import { gotoAppClean } from './helpers.js';

const README_BODY = [
  '# Cookbook',
  '',
  'See [contributing](./CONTRIBUTING.md) for details.',
  '',
  'Source code lives in [src/main.py](./src/main.py).',
  '',
  '![hero](./images/hero.png)',
].join('\n');

const CONTRIBUTING_BODY = '# Contributing\n\nThanks for helping out.';

async function mockGitHub(context) {
  await context.route('https://raw.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/anthropics/anthropic-cookbook/main/README.md')) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: README_BODY });
    }
    if (url.endsWith('/anthropics/anthropic-cookbook/main/CONTRIBUTING.md')) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: CONTRIBUTING_BODY });
    }
    if (url.endsWith('/anthropics/anthropic-cookbook/main/missing.md')) {
      return route.fulfill({ status: 404, body: 'Not Found' });
    }
    return route.fulfill({ status: 404, body: 'Not Found' });
  });
  await context.route('https://api.github.com/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/repos/anthropics/anthropic-cookbook')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ default_branch: 'main' }),
      });
    }
    if (url.includes('/repos/anthropics/anthropic-cookbook/readme')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: 'README.md', sha: 'abc', download_url: 'https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md' }),
      });
    }
    return route.fulfill({ status: 404, body: 'Not Found' });
  });
}

async function openModalAndSubmit(page, url) {
  await page.locator('[data-dropdown="import"] .dropdown__trigger').click();
  await page.locator('[data-action="load-github-url"]').click();
  await expect(page.locator('#gh-load-modal')).toBeVisible();
  await page.locator('#gh-load-url').fill(url);
  await page.locator('#gh-modal-submit').click();
}

test.describe('Load from GitHub URL', () => {
  test('blob URL: loads the README and shows it in the preview', async ({ page, context }) => {
    await mockGitHub(context);
    await gotoAppClean(page);
    await openModalAndSubmit(page, 'https://github.com/anthropics/anthropic-cookbook/blob/main/README.md');
    await expect(page.locator('#gh-load-modal')).toBeHidden();
    await expect(page.locator('#preview h1')).toContainText('Cookbook');
  });

  test('bare repo URL: resolves default branch and README', async ({ page, context }) => {
    await mockGitHub(context);
    await gotoAppClean(page);
    await openModalAndSubmit(page, 'https://github.com/anthropics/anthropic-cookbook');
    await expect(page.locator('#preview h1')).toContainText('Cookbook');
  });

  test('non-.md links rewrite to github.com blob URLs', async ({ page, context }) => {
    await mockGitHub(context);
    await gotoAppClean(page);
    await openModalAndSubmit(page, 'https://github.com/anthropics/anthropic-cookbook/blob/main/README.md');
    const codeLink = page.locator('#preview a[data-gh-remote="1"]', { hasText: 'src/main.py' });
    await expect(codeLink).toHaveAttribute('href', 'https://github.com/anthropics/anthropic-cookbook/blob/main/src/main.py');
    await expect(codeLink).toHaveAttribute('target', '_blank');
  });

  test('relative image src rewrites to raw.githubusercontent.com', async ({ page, context }) => {
    await mockGitHub(context);
    await gotoAppClean(page);
    await openModalAndSubmit(page, 'https://github.com/anthropics/anthropic-cookbook/blob/main/README.md');
    const img = page.locator('#preview img[alt="hero"]');
    await expect(img).toHaveAttribute('src', 'https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/images/hero.png');
  });

  test('clicking a sibling .md link lazy-fetches and opens it as a new tab', async ({ page, context }) => {
    await mockGitHub(context);
    await gotoAppClean(page);
    await openModalAndSubmit(page, 'https://github.com/anthropics/anthropic-cookbook/blob/main/README.md');
    await expect(page.locator('#tabs-scroll .tab')).toHaveCount(2);
    const link = page.locator('#preview a[data-gh-remote="1"]', { hasText: 'contributing' });
    await link.click();
    await expect(page.locator('#preview h1')).toContainText('Contributing');
    await expect(page.locator('#tabs-scroll .tab')).toHaveCount(3);
  });

  test('non-markdown blob URL is rejected with an inline error', async ({ page, context }) => {
    await mockGitHub(context);
    await gotoAppClean(page);
    await openModalAndSubmit(page, 'https://github.com/anthropics/anthropic-cookbook/blob/main/package.json');
    await expect(page.locator('#gh-load-error')).toBeVisible();
    await expect(page.locator('#gh-load-error')).toContainText(/markdown/i);
  });

  test('Esc closes the modal', async ({ page }) => {
    await gotoAppClean(page);
    await page.locator('[data-dropdown="import"] .dropdown__trigger').click();
    await page.locator('[data-action="load-github-url"]').click();
    await expect(page.locator('#gh-load-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#gh-load-modal')).toBeHidden();
  });

  test.describe('mobile viewport (≤900px)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('upload icon opens menu containing GitHub option', async ({ page, context }) => {
      await mockGitHub(context);
      await gotoAppClean(page);
      await page.locator('#btn-upload').click();
      await expect(page.locator('[data-dropdown="import"][data-open="true"]')).toBeVisible();
      await expect(page.locator('[data-action="upload-files"]')).toBeVisible();
      await expect(page.locator('[data-action="load-github-url"]')).toBeVisible();
      // Pick the GitHub option, modal opens, load works.
      await page.locator('[data-action="load-github-url"]').click();
      await expect(page.locator('#gh-load-modal')).toBeVisible();
      await page.locator('#gh-load-url').fill('https://github.com/anthropics/anthropic-cookbook/blob/main/README.md');
      await page.locator('#gh-modal-submit').click();
      await expect(page.locator('#gh-load-modal')).toBeHidden();
      await expect(page.locator('#preview h1')).toContainText('Cookbook');
    });

    test('input has 16px font-size to prevent iOS auto-zoom', async ({ page }) => {
      await gotoAppClean(page);
      await page.locator('#btn-upload').click();
      await page.locator('[data-action="load-github-url"]').click();
      const fontSize = await page.locator('#gh-load-url').evaluate(
        (el) => getComputedStyle(el).fontSize
      );
      expect(parseFloat(fontSize)).toBeGreaterThanOrEqual(16);
    });

    test('close button meets 44×44 touch target', async ({ page }) => {
      await gotoAppClean(page);
      await page.locator('#btn-upload').click();
      await page.locator('[data-action="load-github-url"]').click();
      // Read computed CSS so a mid-animation transform doesn't shave a fractional pixel from the bbox.
      const close = page.locator('#gh-modal-close');
      const dims = await close.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { w: parseFloat(cs.width), h: parseFloat(cs.height) };
      });
      expect(dims.w).toBeGreaterThanOrEqual(44);
      expect(dims.h).toBeGreaterThanOrEqual(44);
    });
  });
});
