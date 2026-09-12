import { expect, test, type Page } from '@playwright/test';
import { API, registerThroughUi, tokenFromBrowser, uniqueEmail } from './helpers';

/**
 * M11's acceptance criterion — "the same product priced in three currencies"
 * — demonstrated the way a person would check it: one basket, three currencies,
 * three different totals, and the yen one with no decimal places anywhere.
 *
 * The exponent is the point. USD and EUR both have two decimals, so a page that
 * assumed hundredths would render them correctly by accident. It would render
 * ¥3815 as ¥38.15, and nothing in a dollar-only test suite would notice.
 *
 * No payment is touched, so like the other non-checkout suites this needs the
 * stack and the storefront but no webhook tunnel.
 */

const TEE = 'black-tee-medium';

/** The seeded rates, at 1e8 scale. If the seed changes, so do these. */
const SEEDED = { EUR: 92_500_000, JPY: 15_000_000_000 };

async function quoteFor(items: { productId: string; qty: number }[], currency?: string) {
  const response = await fetch(`${API}/pricing/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      destination: { country: 'US', region: 'CA' },
      ...(currency ? { currency } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`quote failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/** Formats the way the page does, with the exponent the quote reports. */
function money(amountMinor: number, currency: string, exponent: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    amountMinor / 10 ** exponent,
  );
}

const productIds = new Map<string, string>();

async function productId(slug: string): Promise<string> {
  const cached = productIds.get(slug);
  if (cached) return cached;
  const response = await fetch(`${API}/catalog/products/${slug}`);
  if (!response.ok) {
    throw new Error(`product lookup failed: ${response.status} ${await response.text()}`);
  }
  const product = await response.json();
  productIds.set(slug, product.id);
  return product.id;
}

async function addToCart(page: Page, slug: string): Promise<void> {
  await page.goto(`/products/${slug}`);
  await page.getByTestId('add-to-cart').click();
  // Navigating away before the POST settles aborts it — see shipping.spec.ts.
  await expect(page.getByTestId('added-notice')).toBeVisible();
}

/**
 * The switcher reloads the page so every price re-quotes, so a selection is a
 * navigation as far as Playwright is concerned.
 */
async function chooseCurrency(page: Page, code: string): Promise<void> {
  await Promise.all([
    page.waitForLoadState('load'),
    page.getByTestId('currency-switcher').selectOption(code),
  ]);
  await page.goto('/cart');
}

test.describe('currency', () => {
  test('one basket, three currencies, three totals — and yen has no decimals', async ({ page }) => {
    await addToCart(page, TEE);
    await page.goto('/cart');
    await page.getByTestId('region-selector').selectOption('US-CA');

    const items = [{ productId: await productId(TEE), qty: 1 }];
    const seen: Record<string, number> = {};

    for (const code of ['USD', 'EUR', 'JPY']) {
      const expected = await quoteFor(items, code);
      expect(expected.currency).toBe(code);

      await chooseCurrency(page, code);

      // Exact figures, formatted with the exponent the API reports. Playwright
      // retries until the re-quote lands, so this is both the wait and the
      // check, and it cannot pass on a stale value from the previous currency.
      await expect(page.getByTestId('cart-total')).toHaveText(
        money(expected.totalMinor, code, expected.exponent),
      );
      await expect(page.getByTestId('cart-subtotal')).toHaveText(
        money(expected.subtotalMinor, code, expected.exponent),
      );

      seen[code] = expected.totalMinor;
    }

    // The yen figure on the page must have no decimal point. This is the
    // assertion a hundredths-assuming page fails — it would show ¥38.15.
    const yenTotal = await page.getByTestId('cart-total').textContent();
    expect(yenTotal).toMatch(/^¥[\d,]+$/);

    // And the three are genuinely different numbers, not one number relabelled.
    expect(new Set(Object.values(seen)).size).toBe(3);
  });

  test('the JPY quote applies the exponent, not just the rate', async ({ page }) => {
    // 1999 cents × 150 × 10^(0−2) = 2998.5 → ¥2999.
    // NOT ¥299,850 (dropping the exponent) and NOT ¥29 (treating yen as cents).
    const items = [{ productId: await productId(TEE), qty: 1 }];
    const usd = await quoteFor(items, 'USD');
    const jpy = await quoteFor(items, 'JPY');

    expect(usd.lines[0].unitPriceMinor).toBe(1999);
    expect(jpy.exponent).toBe(0);
    expect(jpy.fxRateE8).toBe(SEEDED.JPY);
    expect(jpy.lines[0].unitPriceMinor).toBe(2999);

    // Sanity on the page too: the unit price row for a yen basket.
    await addToCart(page, TEE);
    await chooseCurrency(page, 'JPY');
    await expect(page.getByTestId('cart-subtotal')).toHaveText('¥2,999');
  });

  test('an order is shown in the currency it was placed in, whatever the header says', async ({
    page,
  }) => {
    await registerThroughUi(page, uniqueEmail());
    const token = await tokenFromBrowser(page);

    await addToCart(page, TEE);
    await chooseCurrency(page, 'JPY');
    await page.getByTestId('region-selector').selectOption('US-CA');

    const expected = await quoteFor([{ productId: await productId(TEE), qty: 1 }], 'JPY');
    await expect(page.getByTestId('cart-total')).toHaveText(money(expected.totalMinor, 'JPY', 0));

    await page.getByTestId('checkout').click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

    // The order page renders what was stored: yen, no decimals, and the rate.
    await expect(page.getByTestId('order-total')).toHaveText(money(expected.totalMinor, 'JPY', 0));
    await expect(page.getByTestId('order-fx-note')).toContainText('Converted from USD at 150.0000');

    const orderId = page.url().split('/').pop()!;
    const order = await (
      await fetch(`${API}/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    expect(order.currency).toBe('JPY');
    expect(order.exponent).toBe(0);
    expect(order.baseCurrency).toBe('USD');
    expect(order.fxRateE8).toBe(SEEDED.JPY);

    // Now switch the header back to dollars. The order must NOT restate itself.
    await chooseCurrency(page, 'USD');
    await page.goto(`/orders/${orderId}`);
    await expect(page.getByTestId('order-total')).toHaveText(money(expected.totalMinor, 'JPY', 0));
  });

  test('the switcher lists what pricing offers, from the API', async ({ page }) => {
    await page.goto('/');
    const offered = (await (await fetch(`${API}/pricing/currencies`)).json()) as { code: string }[];

    // The options arrive from a fetch after mount. `allTextContents()` does not
    // auto-wait, so pin the count first — it is the wait and the check.
    const option = page.getByTestId('currency-switcher').locator('option');
    await expect(option).toHaveCount(offered.length + 1); // + the "Currency…" placeholder
    const options = await option.allTextContents();

    for (const currency of offered) {
      expect(options).toContain(currency.code);
    }
  });
});
