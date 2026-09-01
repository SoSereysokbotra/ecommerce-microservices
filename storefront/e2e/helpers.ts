import { expect, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';

/** A fresh account per run, so tests never collide on a unique email. */
export function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`;
}

export async function registerThroughUi(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name').fill('E2E Shopper');
  await page.getByLabel('Password').fill('Str0ngPassw0rd!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
}

export async function stockFor(slug: string): Promise<number> {
  const product = await (await fetch(`${API}/catalog/products/${slug}`)).json();
  const rows = await (await fetch(`${API}/inventory/stock?productIds=${product.id}`)).json();
  return rows[0]?.availableQty ?? 0;
}

/**
 * Completes the payment through Stripe's API rather than by typing into the
 * Payment Element's iframe.
 *
 * The card form is Stripe's own component; driving it would be testing their
 * code, and it is the flakiest thing in any Stripe test suite. What this suite
 * must prove is ours: that the order page notices the outcome and reflects it.
 */
export async function payViaStripe(
  orderId: string,
  token: string,
  paymentMethod: 'pm_card_visa' | 'pm_card_chargeDeclined',
): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error('STRIPE_SECRET_KEY must be set to run the payment E2E tests');
  }

  // Wait for the saga to reserve stock and create the intent.
  let clientSecret: string | undefined;
  for (let i = 0; i < 30 && !clientSecret; i++) {
    const response = await fetch(`${API}/payments/by-order/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      clientSecret = (await response.json()).clientSecret ?? undefined;
    }
    if (!clientSecret) await new Promise((r) => setTimeout(r, 1000));
  }

  if (!clientSecret) {
    throw new Error(`No payment intent appeared for order ${orderId}`);
  }

  const intentId = clientSecret.split('_secret_')[0];

  const confirm = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ payment_method: paymentMethod }),
  });

  // A declined card returns 402 from Stripe — expected, not a test failure.
  if (!confirm.ok && confirm.status !== 402) {
    throw new Error(`Stripe confirm failed: ${confirm.status} ${await confirm.text()}`);
  }
}

export async function tokenFromBrowser(page: Page): Promise<string> {
  const token = await page.evaluate(() => window.localStorage.getItem('commerce.token'));
  if (!token) throw new Error('No auth token in localStorage — did registration succeed?');
  return token;
}
