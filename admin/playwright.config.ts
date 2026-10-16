import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for Admin Dashboard & Operations Console.
 *
 * Runs against the live Next.js 16 back-office app on port 3200 communicating
 * with the API Gateway at http://localhost:3000/api/v1.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_ADMIN_URL ?? 'http://localhost:3200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
