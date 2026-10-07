import { expect, test } from '@playwright/test';
import { API } from './helpers';

interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
}

interface RecommendationsPayload {
  items: Array<{
    productId: string;
    sku: string;
    slug: string;
    name: string;
    priceMinor: number;
    currency: string;
    coPurchaseCount: number;
  }>;
  total: number;
}

/**
 * M14's storefront recommendations: "Customers also bought" section.
 *
 * ## Acceptance criteria (docs/M14_RECOMMENDATIONS_PLAN.md §9, §11, §13 step 5)
 * - A product with co-purchases renders "Customers also bought" with product cards.
 * - Clicking a recommendation card navigates to that product's details page.
 * - A product without co-purchases renders nothing at all (no heading, no empty box).
 */
test.describe('recommendations', () => {
  test('a product with recommendations renders the section, cards, and allows navigation', async ({ page }) => {
    // Pick fixtures by inspecting the catalog and recommendations APIs
    const catalogRes = await fetch(`${API}/catalog/products?limit=50`);
    const catalogJson = (await catalogRes.json()) as { data?: CatalogProduct[] };
    const products = catalogJson.data ?? [];

    let targetProduct: CatalogProduct | null = null;
    let expectedRecs: RecommendationsPayload['items'] = [];

    for (const p of products) {
      const recRes = await fetch(`${API}/recommendations/products/${p.id}?limit=4`);
      if (recRes.ok) {
        const recJson = (await recRes.json()) as RecommendationsPayload;
        if (recJson.items && recJson.items.length > 0) {
          targetProduct = p;
          expectedRecs = recJson.items;
          break;
        }
      }
    }

    test.skip(!targetProduct, 'No product with co-purchases found in test environment');
    if (!targetProduct) return;

    await page.goto(`/products/${targetProduct.slug}`);

    // Section appears with "Customers also bought" heading
    const section = page.getByTestId('recommendations-section');
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { level: 2 })).toHaveText('Customers also bought');

    // Section displays at least one recommendation card
    const cards = page.getByTestId('recommendation-card');
    await expect(cards).not.toHaveCount(0);

    const firstCard = cards.first();
    await expect(firstCard).toBeVisible();
    await expect(firstCard).toContainText(expectedRecs[0].sku);

    // Clicking a card navigates to that product's page
    const cardLink = firstCard.getByRole('link');
    const targetName = await cardLink.textContent();
    await cardLink.click();

    await expect(page).toHaveURL(new RegExp(`/products/${expectedRecs[0].slug}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      targetName ?? expectedRecs[0].name,
    );
  });

  test('a product with no recommendations renders nothing at all', async ({ page }) => {
    const catalogRes = await fetch(`${API}/catalog/products?limit=50`);
    const catalogJson = (await catalogRes.json()) as { data?: CatalogProduct[] };
    const products = catalogJson.data ?? [];

    let emptyProduct: CatalogProduct | null = null;

    for (const p of products) {
      const recRes = await fetch(`${API}/recommendations/products/${p.id}?limit=4`);
      if (recRes.ok) {
        const recJson = (await recRes.json()) as RecommendationsPayload;
        if (!recJson.items || recJson.items.length === 0) {
          emptyProduct = p;
          break;
        }
      }
    }

    test.skip(!emptyProduct, 'No product without recommendations found in test environment');
    if (!emptyProduct) return;

    await page.goto(`/products/${emptyProduct.slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Absent entirely: no heading, no section
    await expect(page.getByTestId('recommendations-section')).toHaveCount(0);
  });
});
