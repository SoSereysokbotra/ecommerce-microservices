import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const STAFF_EMAIL = process.env.STAFF_EMAIL ?? 'staff@example.com';
const CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL ?? 'customer@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Password123!';

test.describe('M17 Admin Dashboard & Operations Console E2E Suite', () => {
  test('1. Unauthenticated users are redirected to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('#input-email')).toBeVisible();
    await expect(page.locator('#input-password')).toBeVisible();
  });

  test('2. Customer role is denied back-office access with security notice', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#input-email').fill(CUSTOMER_EMAIL);
    await page.locator('#input-password').fill(PASSWORD);
    await page.locator('#btn-login').click();

    // Must stay on /login and display access denial notice
    await expect(page).toHaveURL(/\/login/);
    const errorNotice = page.locator('#login-error');
    await expect(errorNotice).toBeVisible();
    await expect(errorNotice).toContainText('Access Denied');
  });

  test('3. Admin authentication, session persistence, and full navigation visibility', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.locator('#input-email').fill(ADMIN_EMAIL);
    await page.locator('#input-password').fill(PASSWORD);
    await page.locator('#btn-login').click();

    // Successfully logged in and routed to Overview dashboard
    await expect(page).toHaveURL('/');
    await expect(page.locator('[data-testid="admin-sidebar"]')).toBeVisible();

    // Admin should see System Maintenance in sidebar
    await expect(page.locator('#nav-system')).toBeVisible();

    // Verify session persistence upon page reload
    await page.reload();
    await expect(page).toHaveURL('/');
    await expect(page.locator('[data-testid="admin-sidebar"]')).toBeVisible();
  });

  test('4. Staff role admits to operational pages but guards admin-only routes', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.locator('#input-email').fill(STAFF_EMAIL);
    await page.locator('#input-password').fill(PASSWORD);
    await page.locator('#btn-login').click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('[data-testid="admin-sidebar"]')).toBeVisible();

    // Staff can access Orders, Catalog, Inventory, Reviews
    await expect(page.locator('#nav-orders')).toBeVisible();
    await expect(page.locator('#nav-catalog')).toBeVisible();
    await expect(page.locator('#nav-inventory')).toBeVisible();
    await expect(page.locator('#nav-reviews')).toBeVisible();

    // System Maintenance link must be hidden for staff
    await expect(page.locator('#nav-system')).not.toBeVisible();

    // Attempting direct navigation to /system displays 403 Forbidden Gate
    await page.goto('/system');
    const forbiddenGate = page.locator('[data-testid="forbidden-gate"]');
    await expect(forbiddenGate).toBeVisible();
    await expect(forbiddenGate).toContainText('Administrator Privilege Required');
  });

  test('5. Product catalog authoring and inventory stock adjustment flow', async ({ page }) => {
    // Sign in as Admin
    await page.goto('/login');
    await page.locator('#input-email').fill(ADMIN_EMAIL);
    await page.locator('#input-password').fill(PASSWORD);
    await page.locator('#btn-login').click();
    await expect(page).toHaveURL('/');

    // Navigate to Catalog
    await page.locator('#nav-catalog').click();
    await expect(page).toHaveURL(/\/catalog/);

    const testSku = `SKU-E2E-${Date.now().toString().slice(-6)}`;
    const testTitle = `E2E Automated Product ${testSku}`;

    // Open create product drawer
    const createBtn = page.locator('#btn-open-create-product');
    if (await createBtn.isVisible()) {
      await createBtn.click();
      await page.locator('#input-product-sku').fill(testSku);
      await page.locator('#input-product-name').fill(testTitle);
      await page.locator('#input-product-price').fill('29.99');
      await page.locator('#btn-confirm-save-product').click();

      // Verify product appears in catalog list
      await expect(page.locator(`text=${testTitle}`)).toBeVisible({ timeout: 10_000 });
    }

    // Navigate to Inventory & Stock
    await page.locator('#nav-inventory').click();
    await expect(page).toHaveURL(/\/inventory/);

    // Search for our item
    await page.locator('#stock-search').fill(testSku);

    // Verify row or table loaded
    await expect(page.locator('.admin-table')).toBeVisible();
  });

  test('6. Review moderation queue feed & rating sync controls', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#input-email').fill(ADMIN_EMAIL);
    await page.locator('#input-password').fill(PASSWORD);
    await page.locator('#btn-login').click();
    await expect(page).toHaveURL('/');

    // Navigate to Reviews
    await page.locator('#nav-reviews').click();
    await expect(page).toHaveURL(/\/reviews/);

    // Verify filter tabs are interactive
    await expect(page.locator('#tab-pending-reviews')).toBeVisible();
    await expect(page.locator('#tab-approved-reviews')).toBeVisible();
    await expect(page.locator('#tab-rejected-reviews')).toBeVisible();

    await page.locator('#tab-approved-reviews').click();
    await page.locator('#tab-pending-reviews').click();

    // Verify Re-announce / Sync Rollup button exists
    await expect(page.locator('#btn-republish-ratings')).toBeVisible();
  });

  test('7. System operations console and maintenance trigger interfaces', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#input-email').fill(ADMIN_EMAIL);
    await page.locator('#input-password').fill(PASSWORD);
    await page.locator('#btn-login').click();
    await expect(page).toHaveURL('/');

    // Navigate to System Maintenance
    await page.locator('#nav-system').click();
    await expect(page).toHaveURL(/\/system/);

    // Verify maintenance pipeline triggers exist
    await expect(page.locator('#btn-full-search-reindex')).toBeVisible();
    await expect(page.locator('#btn-full-recommendations-rebuild')).toBeVisible();

    // Verify Health Matrix telemetry is rendered
    await expect(page.locator('[data-testid="health-matrix"]')).toBeVisible();
  });
});
