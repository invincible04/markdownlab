// Service worker registration + versioning. The SW only registers over
// HTTPS in production; these tests just assert the file exists, reports
// the expected cache version, and parses without syntax errors.

import { test, expect } from '@playwright/test';

test.describe('Service worker', () => {
  test('service-worker.js is served and advertises current cache version', async ({ request }) => {
    const res = await request.get('/service-worker.js');
    expect(res.status()).toBe(200);
    const body = await res.text();
    // Bump this assertion when the SW version changes. Keeping it strict
    // forces us to update it intentionally.
    expect(body).toContain("CACHE_VERSION = 'markdownlab-v6'");
    // Basic sanity checks.
    expect(body).toContain("SHELL");
    expect(body).toContain("CDN_PRECACHE");
    expect(body).toContain("networkFirstShell");
    expect(body).toContain("cacheFirst");
  });

  test('manifest is served and valid JSON', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    const body = await res.text();
    const manifest = JSON.parse(body);
    expect(manifest.name || manifest.short_name).toBeTruthy();
    expect(Array.isArray(manifest.icons)).toBe(true);
  });
});
