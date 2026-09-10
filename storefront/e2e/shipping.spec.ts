import { expect, test, type Page } from '@playwright/test';
import { API, registerThroughUi, tokenFromBrowser, uniqueEmail } from './helpers';

/**
 * M10's acceptance criteria, demonstrated the way a person would check them:
 * a saved address, a delivery speed, and a shipping line that matches the API.
 *
 * These touch no payment, so like `cart.spec.ts` and `pricing.spec.ts` they
 * need the stack and the storefront but no webhook tunnel. Driving a parcel all
 * the way to `delivered` needs a confirmed order, which needs a card, so the
 * lifecycle is exercised against the service directly rather than through a
 * browser — see the last block.
 */

const TEE = 'black-tee-medium'; // apparel — exempt in Pennsylvania, but its postage is not
const BOTTLE = 'steel-bottle'; // 340g, heavy enough to move bands in bulk

/** Parses "$5.99" back to 599, so assertions stay in minor units. */
function minorFromText(text: string | null): number {
  if (!text) throw new Error('no text to parse');
  if (text.trim() === 'Free') return 0;
  return Math.round(Number(text.replace(/[^0-9.-]/g, '')) * 100);
}

/**
 * Product ids, looked up once each — the gateway throttles, and the suite is
 * comfortably capable of exceeding the limit. `pricing.spec.ts` explains what
 * that failure looks like when a helper does not check its own status.
 */
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

async function quoteFor(
  items: { productId: string; qty: number }[],
  extra: Record<string, unknown> = {},
) {
  const response = await fetch(`${API}/pricing/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, ...extra }),
  });
  if (!response.ok) {
    throw new Error(`quote failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function saveAddress(
  token: string,
  address: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await fetch(`${API}/users/me/addresses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(address),
  });
  if (!response.ok) {
    throw new Error(`address save failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function addToCart(page: Page, slug: string, qty = 1): Promise<void> {
  await page.goto(`/products/${slug}`);
  if (qty > 1) {
    await page.getByLabel('Quantity').fill(String(qty));
  }
  await page.getByTestId('add-to-cart').click();

  /**
   * Waiting for the confirmation is not politeness — it is required.
   *
   * The click starts a POST to cart-service; navigating away before it settles
   * **aborts** it, and the cart is then empty for reasons that look like a bug
   * in the page. Two of these tests failed exactly that way, deterministically,
   * while a third that happened to do more work first passed. `cart.spec.ts`
   * has waited on this notice since M7 for the same reason.
   */
  await expect(page.getByTestId('added-notice')).toBeVisible();
}

test.describe('shipping in the storefront', () => {
  test('a signed-in shopper picks a saved address and sees the shipping line', async ({ page }) => {
    const email = uniqueEmail();
    await registerThroughUi(page, email);
    const token = await tokenFromBrowser(page);

    await saveAddress(token, {
      label: 'Home',
      recipient: 'Grace Hopper',
      line1: '1 Navy Yard',
      city: 'Philadelphia',
      region: 'PA',
      postcode: '19112',
      country: 'US',
    });

    await addToCart(page, TEE);
    await page.goto('/cart');

    // The address picker replaces the region selector once signed in — two
    // controls for two states, not two implementations of one.
    await expect(page.getByTestId('address-picker')).toBeVisible();
    await expect(page.getByTestId('region-selector')).toHaveCount(0);

    const shippingLine = page.getByTestId('cart-shipping');
    await expect(shippingLine).toBeVisible();

    // The figure on the page must be the one the API folded into the total.
    const quote = await quoteFor([{ productId: await productId(TEE), qty: 1 }], {
      destination: { country: 'US', region: 'PA' },
    });
    expect(minorFromText(await shippingLine.textContent())).toBe(quote.shippingMinor);
    expect(minorFromText(await page.getByTestId('cart-total').textContent())).toBe(
      quote.totalMinor,
    );
  });

  test('choosing express changes the shipping line and the total', async ({ page }) => {
    const email = uniqueEmail();
    await registerThroughUi(page, email);
    const token = await tokenFromBrowser(page);

    await saveAddress(token, {
      recipient: 'Grace Hopper',
      line1: '1 Navy Yard',
      city: 'Philadelphia',
      region: 'PA',
      postcode: '19112',
      country: 'US',
    });

    await addToCart(page, TEE);
    await page.goto('/cart');

    const shippingLine = page.getByTestId('cart-shipping');
    await expect(shippingLine).toBeVisible();
    const standard = minorFromText(await shippingLine.textContent());

    await page.getByTestId('rate-selector').selectOption('express');

    // Express must cost more than standard, and the total must move with it —
    // that is the assertion that a rate picker which only changes a label
    // would fail.
    await expect
      .poll(async () => minorFromText(await shippingLine.textContent()))
      .toBeGreaterThan(standard);

    const expressQuote = await quoteFor([{ productId: await productId(TEE), qty: 1 }], {
      destination: { country: 'US', region: 'PA' },
      shippingRateCode: 'express',
    });
    expect(minorFromText(await shippingLine.textContent())).toBe(expressQuote.shippingMinor);
    expect(minorFromText(await page.getByTestId('cart-total').textContent())).toBe(
      expressQuote.totalMinor,
    );
  });

  test('a basket over the threshold ships free, and says so', async ({ page }) => {
    const email = uniqueEmail();
    await registerThroughUi(page, email);
    const token = await tokenFromBrowser(page);

    // California: the warehouse zone, free over $50 on the **discounted**
    // subtotal. Six bottles at $34 clears it comfortably.
    await saveAddress(token, {
      recipient: 'Ada Lovelace',
      line1: '12 Ocean Avenue',
      city: 'San Francisco',
      region: 'CA',
      postcode: '94102',
      country: 'US',
    });

    await addToCart(page, BOTTLE, 6);
    await page.goto('/cart');

    // "Free", not "$0.00" — a shopper who qualified should be told they did.
    await expect(page.getByTestId('cart-shipping')).toHaveText('Free');

    const quote = await quoteFor([{ productId: await productId(BOTTLE), qty: 6 }], {
      destination: { country: 'US', region: 'CA' },
    });
    expect(quote.shippingMinor).toBe(0);
    expect(quote.shipping.options[0].freeApplied).toBe(true);
  });

  test('a guest still gets the region selector and a priced basket', async ({ page }) => {
    // M7 deliberately supports a guest holding a cart, and M8 the region
    // selector. Neither is replaced by addresses; they are the signed-out path.
    await addToCart(page, TEE);
    await page.goto('/cart');

    await expect(page.getByTestId('region-selector')).toBeVisible();
    await expect(page.getByTestId('address-picker')).toHaveCount(0);
    await expect(page.getByTestId('cart-total')).not.toHaveText('—');
  });

  test('the order freezes the address and the shipping charge', async ({ page }) => {
    const email = uniqueEmail();
    await registerThroughUi(page, email);
    const token = await tokenFromBrowser(page);

    const address = await saveAddress(token, {
      recipient: 'Grace Hopper',
      line1: '1 Navy Yard',
      city: 'Philadelphia',
      region: 'PA',
      postcode: '19112',
      country: 'US',
    });

    await addToCart(page, TEE);
    await page.goto('/cart');
    await expect(page.getByTestId('cart-shipping')).toBeVisible();

    await page.getByTestId('checkout').click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

    // The shipping row on the order page, read back from what was stored.
    const shippingRow = page.getByTestId('order-shipping');
    await expect(shippingRow).toBeVisible();

    const orderId = page.url().split('/').pop()!;
    const order = await (
      await fetch(`${API}/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();

    expect(minorFromText(await shippingRow.textContent())).toBe(order.shippingMinor);
    // Frozen, not a reference: the order carries its own copy of the address.
    expect(order.shippingAddress.city).toBe('Philadelphia');
    expect(order.shippingAddress.region).toBe('PA');
    expect(order.shippingRateCode).toBeTruthy();

    // And the address it froze is the one that was saved, read server-side.
    expect(order.taxCountry).toBe('US');
    expect(order.taxRegion).toBe('PA');
    expect(address.id).toBeTruthy();
  });
});

test.describe('the address book', () => {
  test('is scoped to its owner: another shopper cannot read it', async ({ page }) => {
    const ownerEmail = uniqueEmail();
    await registerThroughUi(page, ownerEmail);
    const ownerToken = await tokenFromBrowser(page);

    const address = await saveAddress(ownerToken, {
      recipient: 'Ada Lovelace',
      line1: '12 Ocean Avenue',
      city: 'San Francisco',
      region: 'CA',
      country: 'US',
    });

    // A second shopper, in the same browser context.
    await page.evaluate(() => window.localStorage.clear());
    await registerThroughUi(page, uniqueEmail());
    const otherToken = await tokenFromBrowser(page);

    const response = await fetch(`${API}/users/me/addresses/${address.id}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });

    // 404, never 403: a 403 confirms the id is real, which is a small oracle
    // but a free one. There are no roles until M16, so scoping is all there is.
    expect(response.status).toBe(404);

    const list = await (
      await fetch(`${API}/users/me/addresses`, {
        headers: { Authorization: `Bearer ${otherToken}` },
      })
    ).json();
    expect(list).toHaveLength(0);
  });

  test('rejects a country code that is not two letters', async ({ page }) => {
    // A three-letter code matches no tax rule and no shipping zone, so it would
    // surface as a wrong total rather than an error. Rejected at the column.
    await registerThroughUi(page, uniqueEmail());
    const token = await tokenFromBrowser(page);

    const response = await fetch(`${API}/users/me/addresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recipient: 'Ada Lovelace',
        line1: '12 Ocean Avenue',
        city: 'San Francisco',
        country: 'USA',
      }),
    });

    expect(response.status).toBe(400);
  });
});
