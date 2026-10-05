import { expect, test } from '@playwright/test';
import { registerThroughUi, uniqueEmail } from './helpers';

/**
 * M13's storefront reviews: star rollup, approved reviews list, and eligibility.
 *
 * ## Acceptance criteria (docs/M13_REVIEWS_PLAN.md §1, §7)
 * - Approved reviews appear on the product page along with the star average.
 * - Anonymous visitors can read reviews and stars, but see no submission form.
 * - Signed-in customers who have not purchased the product see the explanation
 *   line ("Only customers who bought this product can review it") rather than
 *   a submission form.
 */
test.describe('reviews', () => {
  test('a product page shows stars and the review list', async ({ page }) => {
    // USB-C Cable has an approved review seeded in M13
    await page.goto('/products/usb-c-cable');

    // Stars component displays the rating average and review count
    const stars = page.getByTestId('stars').first();
    await expect(stars).toBeVisible();
    await expect(stars).toContainText('4.0');
    await expect(stars).toContainText('1 review');

    // Approved reviews list is visible below the product
    await expect(page.getByTestId('reviews-list')).toBeVisible();
    const reviews = page.getByTestId('review-card');
    await expect(reviews).toHaveCount(1);
    await expect(reviews.first()).toContainText('Solid');
    await expect(reviews.first()).toContainText('Does the job nicely.');
    await expect(reviews.first()).toContainText('M13 Shopper');
  });

  test('a signed-out visitor sees no form', async ({ page }) => {
    await page.goto('/products/usb-c-cable');

    // Product and reviews are readable without authentication
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('USB-C Cable');
    await expect(page.getByTestId('reviews-section')).toBeVisible();

    // Anonymous visitors cannot review: no form, no edit link, no eligibility notice
    await expect(page.getByTestId('review-form')).toHaveCount(0);
    await expect(page.getByTestId('edit-review-link')).toHaveCount(0);
    await expect(page.getByTestId('cannot-review-reason')).toHaveCount(0);
  });

  test('a signed-in visitor with no purchase sees the "cannot review" line', async ({ page }) => {
    // Register a fresh customer who has made no purchases
    const email = uniqueEmail();
    await registerThroughUi(page, email);

    // Navigate to the product page
    await page.goto('/products/usb-c-cable');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('USB-C Cable');

    // Eligibility check runs and shows the explanation line
    const cannotReview = page.getByTestId('cannot-review-reason');
    await expect(cannotReview).toBeVisible();
    await expect(cannotReview).toHaveText('Only customers who bought this product can review it');

    // Form is not rendered when canReview is false
    await expect(page.getByTestId('review-form')).toHaveCount(0);
  });
});
