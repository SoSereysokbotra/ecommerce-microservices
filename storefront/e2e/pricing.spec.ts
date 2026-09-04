import { expect, test } from '@playwright/test';
import { API } from './helpers';

/**
 * M8's acceptance criterion — "order totals correct across three tax regions" —
 * demonstrated the way a person would check it: one basket, three regions,
 * three different totals, in a browser.
 *
 * These touch no payment, so like cart.spec.ts they need the stack and the
 * storefront but no webhook tunnel.
 */

const TEE = 'black-tee-medium'; // apparel — exempt in Pennsylvania
const MUG = 'black-mug'; // drinkware — carries the seeded 15% promotion

/** Formats the way the page does, so assertions compare like with like. */
function money(amountMinor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
}

/** Parses "$100.47" back to 10047, so assertions stay in minor units. */
function minorFromText(text: string | null): number {
  if (!text) throw new Error('no text to parse');
  return Math.round(Number(text.replace(/[^0-9.-]/g, '')) * 100);
}

async function quoteFor(
  items: { productId: string; qty: number }[],
  destination?: { country: string; region?: string },
) {
  const response = await fetch(`${API}/pricing/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, ...(destination ? { destination } : {}) }),
  });
  if (!response.ok) throw new Error(`quote failed: ${response.status}`);
  return response.json();
}

async function productId(slug: string): Promise<string> {
  return (await (await fetch(`${API}/catalog/products/${slug}`)).json()).id;
}

test.describe('pricing', () => {
  test('the cart shows a real quote, not a browser-side sum', async ({ page }) => {
    await page.goto(`/products/${TEE}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();

    await page.goto('/cart');

    // The total the page shows must be the total the API computed — that is
    // the whole point of deleting the client-side sum.
    const expected = await quoteFor([{ productId: await productId(TEE), qty: 1 }], {
      country: 'US',
      region: 'CA',
    });

    await page.getByTestId('region-selector').selectOption('US-CA');
    await expect(page.getByTestId('cart-total')).not.toHaveText('—');

    expect(minorFromText(await page.getByTestId('cart-subtotal').textContent())).toBe(
      expected.subtotalMinor,
    );
    expect(minorFromText(await page.getByTestId('cart-tax').textContent())).toBe(
      expected.taxMinor,
    );
    expect(minorFromText(await page.getByTestId('cart-total').textContent())).toBe(
      expected.totalMinor,
    );
  });

  test('one basket, three regions, three totals', async ({ page }) => {
    await page.goto(`/products/${TEE}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();
    await page.goto(`/products/${MUG}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();

    const items = [
      { productId: await productId(TEE), qty: 1 },
      { productId: await productId(MUG), qty: 1 },
    ];

    await page.goto('/cart');
    const seen: number[] = [];

    for (const [option, destination] of [
      ['US-CA', { country: 'US', region: 'CA' }],
      ['US-PA', { country: 'US', region: 'PA' }],
      ['DE', { country: 'DE' }],
    ] as const) {
      const expected = await quoteFor(items, destination);

      await page.getByTestId('region-selector').selectOption(option);

      // Asserting the exact figure rather than waiting for "something changed":
      // Playwright retries until the refetched quote lands, so this is both the
      // wait and the correctness check, and it cannot pass on a stale value.
      await expect(page.getByTestId('cart-total')).toHaveText(money(expected.totalMinor));
      await expect(page.getByTestId('cart-tax')).toHaveText(money(expected.taxMinor));

      seen.push(expected.totalMinor);
    }

    const [ca, pa, de] = seen;

    // Pennsylvania exempts clothing, California taxes it. If these ever match,
    // the category dimension has stopped working.
    expect(pa).toBeLessThan(ca);

    // Germany's VAT is already inside the price, so its total is exactly the
    // discounted subtotal — lower than anywhere that adds tax on top.
    expect(de).toBeLessThan(pa);

    // Read the amounts, not the rows: a promotion called "Drinkware 15%"
    // contributes its own digits to anything parsing the whole row's text.
    const subtotal = minorFromText(await page.getByTestId('cart-subtotal').textContent());
    const amounts = await page.getByTestId('cart-discount-amount').all();
    let discount = 0;
    for (const amount of amounts) discount += minorFromText(await amount.textContent());
    expect(de).toBe(subtotal - discount);
  });

  test('inclusive tax is labelled differently from tax added on top', async ({ page }) => {
    await page.goto(`/products/${MUG}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();
    await page.goto('/cart');

    const items = [{ productId: await productId(MUG), qty: 1 }];
    const inCalifornia = await quoteFor(items, { country: 'US', region: 'CA' });
    const inGermany = await quoteFor(items, { country: 'DE' });

    await page.getByTestId('region-selector').selectOption('US-CA');
    await expect(page.getByTestId('cart-total')).toHaveText(money(inCalifornia.totalMinor));
    await expect(page.getByTestId('cart-tax-label')).toHaveText(/Sales tax/);
    await expect(page.getByTestId('cart-tax-note')).toHaveCount(0);

    await page.getByTestId('region-selector').selectOption('DE');
    await expect(page.getByTestId('cart-total')).toHaveText(money(inGermany.totalMinor));
    await expect(page.getByTestId('cart-tax-label')).toHaveText(/VAT/);
    // Inclusive tax does not raise the total, which reads as a bug unless the
    // page says why.
    await expect(page.getByTestId('cart-tax-note')).toBeVisible();
  });

  test('the chosen region survives a reload', async ({ page }) => {
    await page.goto(`/products/${MUG}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('added-notice')).toBeVisible();

    await page.goto('/cart');
    await page.getByTestId('region-selector').selectOption('US-PA');
    await expect(page.getByTestId('cart-total')).not.toHaveText('—');

    await page.reload();
    await expect(page.getByTestId('region-selector')).toHaveValue('US-PA');
  });
});
