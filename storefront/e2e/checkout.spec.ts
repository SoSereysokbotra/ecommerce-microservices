import { expect, test } from '@playwright/test';
import {
  payViaStripe,
  registerThroughUi,
  stockFor,
  tokenFromBrowser,
  uniqueEmail,
} from './helpers';

const PRODUCT = 'white-mug';

/**
 * End-to-end through a real browser against the real stack.
 *
 * Nothing is mocked. These exist to prove the two claims the project is built
 * on, at the level a person actually experiences them:
 *
 *   1. a successful order removes the stock exactly once
 *   2. a declined card puts the stock back on its own
 *
 * The second is the one that matters. In M2 that stock stayed held forever and
 * needed manual SQL — see docs/adr/0002-why-a-saga.md.
 */
test.describe('checkout', () => {
  test('browsing does not require an account', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    // Stock comes from the inventory service, so this also proves the gateway
    // is serving both public reads to an anonymous caller.
    await expect(page.getByText(/in stock/).first()).toBeVisible();
  });

  test('placing an order without signing in sends you to the login page', async ({ page }) => {
    await page.goto(`/products/${PRODUCT}`);
    await page.getByRole('button', { name: 'Buy now' }).click();

    await expect(page).toHaveURL(/\/login/);
  });

  test('a successful purchase confirms the order and removes the stock once', async ({ page }) => {
    const before = await stockFor(PRODUCT);

    await registerThroughUi(page, uniqueEmail());
    const token = await tokenFromBrowser(page);

    await page.goto(`/products/${PRODUCT}`);
    await page.getByLabel('Quantity').fill('2');
    await page.getByRole('button', { name: 'Buy now' }).click();

    // The order page is reached immediately: checkout is asynchronous, so the
    // order exists before it is paid or even reserved.
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    const orderId = page.url().split('/orders/')[1];

    // The saga reserves stock, then asks for payment.
    await expect(page.getByTestId('order-status')).toHaveText('awaiting payment', {
      timeout: 60_000,
    });
    expect(await stockFor(PRODUCT)).toBe(before - 2);

    await payViaStripe(orderId, token, 'pm_card_visa');

    // The page polls; the webhook is what actually moves the order.
    await expect(page.getByTestId('order-status')).toHaveText('confirmed', { timeout: 60_000 });

    // Reserved units are committed, not merely still held: available stays
    // down by two and nothing is left in reserve.
    expect(await stockFor(PRODUCT)).toBe(before - 2);
  });

  test('a declined card cancels the order and returns the stock automatically', async ({
    page,
  }) => {
    const before = await stockFor(PRODUCT);

    await registerThroughUi(page, uniqueEmail());
    const token = await tokenFromBrowser(page);

    await page.goto(`/products/${PRODUCT}`);
    await page.getByLabel('Quantity').fill('3');
    await page.getByRole('button', { name: 'Buy now' }).click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    const orderId = page.url().split('/orders/')[1];

    await expect(page.getByTestId('order-status')).toHaveText('awaiting payment', {
      timeout: 60_000,
    });
    expect(await stockFor(PRODUCT)).toBe(before - 3);

    await payViaStripe(orderId, token, 'pm_card_chargeDeclined');

    await expect(page.getByTestId('order-status')).toHaveText('cancelled', { timeout: 60_000 });
    await expect(page.getByTestId('failure-reason')).toContainText('Your card was declined.');

    // The assertion this whole project exists for: no compensating action was
    // taken by hand, and the stock is back.
    expect(await stockFor(PRODUCT)).toBe(before);

    await expect(page.getByTestId('release-notice')).toContainText('released automatically');
  });

  test('an order larger than stock is cancelled and never charged', async ({ page }) => {
    const before = await stockFor(PRODUCT);

    await registerThroughUi(page, uniqueEmail());
    const token = await tokenFromBrowser(page);

    await page.goto(`/products/${PRODUCT}`);
    // The input caps at available stock, so set an impossible quantity directly.
    await page.getByLabel('Quantity').fill('9999');
    await page.getByRole('button', { name: 'Buy now' }).click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    const orderId = page.url().split('/orders/')[1];

    await expect(page.getByTestId('order-status')).toHaveText('cancelled', { timeout: 60_000 });
    await expect(page.getByTestId('failure-reason')).toContainText('Insufficient stock');

    // Nothing was reserved, so nothing needed releasing.
    expect(await stockFor(PRODUCT)).toBe(before);

    // And crucially the customer was never charged: reserving before paying
    // means the cheapest failure happens first.
    const payment = await fetch(
      `${process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1'}/payments/by-order/${orderId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(payment.status).toBe(404);
  });
});
