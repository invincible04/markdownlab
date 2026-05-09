/**
 * Playwright config for MarkdownLab E2E tests.
 *
 * The app is a static site — spin up `python3 -m http.server 5173` as the
 * webServer so tests hit a real origin (service-worker + IndexedDB work).
 * Each test gets a fresh `storageState` via BrowserContext isolation.
 */

// @ts-check
import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Run tests serially to avoid IndexedDB contention on the same DB name
  // across parallel workers. Each worker shares one disk location for
  // the Chromium profile; contexts within one worker isolate fine, but
  // multiple workers racing `indexedDB.open('mdlab')` occasionally trip
  // blocked upgrades. Serial execution keeps the suite deterministic.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
