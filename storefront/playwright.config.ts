import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real stack.
 *
 * These deliberately do NOT mock the backend. The whole point is to prove the
 * asynchronous checkout works through a browser: the order page has to poll
 * while the saga runs in six services, and a mocked API would prove nothing
 * about that.
 *
 * Requires: docker compose up -d, storefront on :3100, and `stripe listen`
 * forwarding to payments so the saga can complete.
 */
export default defineConfig({
  testDir: './e2e',
  // The saga crosses several services and a relay that polls once a second, so
  // assertions need room. Failing fast here would just produce flaky tests.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
