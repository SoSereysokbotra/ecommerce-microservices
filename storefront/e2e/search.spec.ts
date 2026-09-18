import { expect, test } from '@playwright/test';
import { API } from './helpers';

/**
 * M12's storefront: search for a product, filter by category, open a hit.
 *
 * Needs the stack and a filled index — `POST /catalog/admin/republish` once
 * after seeding (HANDOFF §4). No login, no webhook: search is public.
 *
 * The one search-specific lesson: results arrive from a projection, so the
 * assertions wait on the summary line rather than counting cards the instant
 * the page loads (the `added-notice` rule from cart.spec.ts, applied here).
 */
test.describe('search', () => {
  test('the header box searches, and the results match the API', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-box').fill('tee');
    await page.getByTestId('search-box').press('Enter');

    await expect(page).toHaveURL(/\/search\?q=tee$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results for “tee”');

    const expected = await (await fetch(`${API}/search/products?q=tee`)).json();
    await expect(page.getByTestId('search-summary')).toContainText(`${expected.total} matches`);
    await expect(page.getByTestId('search-hit')).toHaveCount(expected.total);

    // "tee" must not match "Ten vinyl stickers" — the fuzziness lesson.
    await expect(page.getByTestId('search-hit').filter({ hasText: 'Sticker' })).toHaveCount(0);
  });

  test('a category facet filters the hits but keeps every category listed', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByTestId('search-summary')).toBeVisible();

    const before = await page.getByTestId('search-facets').getByRole('button').count();
    await page.getByTestId('facet-drinkware').click();

    await expect(page).toHaveURL(/category=drinkware/);
    await expect(page.getByTestId('search-summary')).toContainText('in Drinkware');

    const hits = page.getByTestId('search-hit');
    await expect(hits.first()).toBeVisible();
    for (const hit of await hits.all()) {
      await expect(hit.locator('.pill')).toHaveText('Drinkware');
    }

    // post_filter: the other categories are still there to click, with the
    // "← All categories" button added on top.
    await expect(page.getByTestId('search-facets').getByRole('button')).toHaveCount(before + 1);
    await expect(page.getByTestId('facet-apparel')).toBeVisible();
  });

  test('sorting by price reorders the hits', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByTestId('search-summary')).toBeVisible();
    await page.getByTestId('search-sort').selectOption('price_asc');
    await expect(page).toHaveURL(/sort=price_asc/);

    const cheapest = await (await fetch(`${API}/search/products?sort=price_asc&limit=1`)).json();
    await expect(page.getByTestId('search-hit').first()).toContainText(cheapest.hits[0].name);
  });

  test('a hit opens the product page, which reads catalog directly', async ({ page }) => {
    await page.goto('/search?q=mug');
    await expect(page.getByTestId('search-summary')).toBeVisible();

    const first = page.getByTestId('search-hit').first();
    const name = await first.getByRole('link').textContent();
    await first.getByRole('link').click();

    await expect(page).toHaveURL(/\/products\//);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name ?? '');
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
  });

  test('a stale hit explains itself instead of crashing', async ({ page }) => {
    // The page a search result would link to after the product vanished.
    await page.goto('/products/this-slug-does-not-exist');
    await expect(page.getByTestId('product-gone')).toContainText('no longer available');
    await expect(page.getByRole('link', { name: 'Back to search' })).toBeVisible();
  });

  test('no matches is a message, not a blank page', async ({ page }) => {
    await page.goto('/search?q=zzzzqqqq');
    await expect(page.getByTestId('search-empty')).toContainText('Nothing matches');
  });
});
