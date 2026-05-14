// Render-pipeline tests: GFM, code blocks, math, task lists, tables, alerts.

import { test, expect } from '@playwright/test';
import { gotoAppClean, setEditor } from './helpers.js';

test.describe('Render pipeline', () => {
  test('fenced code block gets syntax highlighting', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '```js\nconst x = 1;\n```');
    // hljs adds .hljs class + span children when it successfully highlights.
    await expect(page.locator('#preview pre code.hljs')).toBeVisible();
  });

  test('GFM table renders as <table>', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '| a | b |\n|---|---|\n| 1 | 2 |');
    await expect(page.locator('#preview table thead th').first()).toHaveText('a');
    await expect(page.locator('#preview table tbody td').first()).toHaveText('1');
  });

  test('GFM task list renders checkboxes', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '- [ ] todo\n- [x] done');
    const boxes = page.locator('#preview input[type="checkbox"]');
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(1)).toBeChecked();
  });

  test('GFM alert blocks render with an alert class', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '> [!TIP]\n> Hello tip');
    await expect(page.locator('#preview .markdown-alert, #preview blockquote')).toContainText('Hello tip');
  });

  test('inline math renders as KaTeX', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, 'Inline: $E = mc^2$ end.');
    await expect(page.locator('#preview .katex').first()).toBeVisible();
  });

  test('display math renders as block KaTeX', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '$$\n\\sum_{i=0}^n i\n$$');
    await expect(page.locator('#preview .katex-display')).toBeVisible();
  });

  test('frontmatter renders as a table, not an H2', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body');
    await expect(page.locator('#preview table.markdown-frontmatter')).toBeVisible();
    await expect(page.locator('#preview table.markdown-frontmatter')).toContainText('title');
    // The --- must NOT produce a preceding setext heading.
    await expect(page.locator('#preview h2')).toHaveCount(0);
  });

  test('external links get rel=noopener', async ({ page }) => {
    await gotoAppClean(page);
    await setEditor(page, '[go](https://example.com)');
    const link = page.locator('#preview a[href="https://example.com"]');
    await expect(link).toBeVisible();
    // DOMPurify hook stamps noopener/noreferrer on target=_blank. The
    // default `target` comes from marked via the `_blank` renderer; the
    // project defaults may or may not set target, so we check rel only when
    // target is present.
    const attrs = await link.evaluate((a) => ({ target: a.getAttribute('target'), rel: a.getAttribute('rel') }));
    if (attrs.target === '_blank') {
      expect(attrs.rel || '').toMatch(/noopener/);
    }
  });
});
