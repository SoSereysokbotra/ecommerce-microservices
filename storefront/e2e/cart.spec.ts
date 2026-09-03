import { expect, test } from '@playwright/test';
import { API, registerThroughUi, uniqueEmail } from './helpers';

/**
 * M7's acceptance criterion: "a guest can build a cart, log in, and keep it."
 *
 * These do not touch payment, so unlike checkout.spec.ts they need no webhook
 * tunnel — only the stack and the storefront.
 */
const PRODUCT = 'usb-c-cable';

async function firstTwoSlugs(): Promise<[string, string]> {
  const body = await (await fetch(`${API}/catalog/products?limit=2`)).json();
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return [rows[0].slug, rows[1].slug];
}

test.describe('cart', () => {
  test('a guest can build a cart without an account', async ({ page }) => {
    await page.goto(`/products/${PRODUCT}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();

    // The header count is fed by the same provider as the cart page, so this
    // also proves they cannot disagree.
    await expect(page.getByTestId('cart-link')).toHaveText(/Cart \(1\)/);

    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
  });

  test('quantities can be changed and lines removed', async ({ page }) => {
    const [first, second] = await firstTwoSlugs();

    await page.goto(`/products/${first}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();

    await page.goto(`/products/${second}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();

    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(2);

    const qty = page.getByTestId('cart-line').first().getByRole('spinbutton');
    await qty.fill('3');
    await qty.blur();
    await expect(page.getByTestId('cart-link')).toHaveText(/Cart \(4\)/);

    await page.getByTestId('cart-line').first().getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
  });

  test('a guest cart survives logging in, and is summed with the account cart', async ({ page }) => {
    // Build a cart as a guest.
    await page.goto(`/products/${PRODUCT}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();
    await expect(page.getByTestId('cart-link')).toHaveText(/Cart \(1\)/);

    // Registering signs the shopper in, and the first request carrying both the
    // JWT and the guest token is what merges the two carts.
    await registerThroughUi(page, uniqueEmail());

    await expect(page.getByTestId('cart-link')).toHaveText(/Cart \(1\)/);
    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(1);

    // The guest token is spent: reloading must not resurrect a second cart.
    await page.reload();
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    expect(await page.evaluate(() => window.localStorage.getItem('commerce.cartToken'))).toBeNull();
  });

  test('checkout empties the cart once the order exists', async ({ page }) => {
    await registerThroughUi(page, uniqueEmail());

    await page.goto(`/products/${PRODUCT}`);
    await page.getByTestId('add-to-cart').click();
    // Wait for the POST to land; navigating straight away races it.
    await expect(page.getByTestId('added-notice')).toBeVisible();

    await page.goto('/cart');
    await page.getByTestId('checkout').click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);

    // Emptied by cart-service consuming order.created, not by the browser.
    // The page loads its cart once on mount, so this reloads until the event
    // has been processed — the same stance as the order page polling rather
    // than the browser declaring an order paid.
    await expect(async () => {
      await page.goto('/cart');
      await expect(page.getByTestId('empty-cart')).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 40_000 });
  });
});
