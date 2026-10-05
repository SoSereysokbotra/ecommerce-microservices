/**
 * Average star rating and review count.
 *
 * ## The integer discipline (ADR-0010, docs/M13_REVIEWS_PLAN.md §4, §7)
 *
 * `ratingAvgE2` is an integer hundredth (437 = 4.37 stars). Never divide by
 * 100 anywhere on the path except the final presentation string here.
 *
 * Renders nothing when `ratingCount` is 0 or null: an unrated product shows
 * no empty stars and no "0 reviews", keeping the search hits and product
 * page clean until someone actually reviews it.
 */
export function Stars({
  ratingAvgE2,
  ratingCount,
}: {
  ratingAvgE2?: number | null;
  ratingCount?: number | null;
}) {
  if (
    !ratingCount ||
    ratingCount <= 0 ||
    ratingAvgE2 === null ||
    ratingAvgE2 === undefined ||
    ratingAvgE2 <= 0
  ) {
    return null;
  }

  // Final display only: format the integer hundredth as decimal with 1 decimal place.
  // 437 -> 4.4, 450 -> 4.5, 500 -> 5.0 (docs/M13_REVIEWS_PLAN.md §7: "4.4 · 12 reviews").
  const displayRating = (ratingAvgE2 / 100).toFixed(1);

  return (
    <span
      className="row small"
      style={{ gap: '0.35rem', alignItems: 'center' }}
      data-testid="stars"
      aria-label={`${displayRating} out of 5 stars (${ratingCount} ${ratingCount === 1 ? 'review' : 'reviews'})`}
    >
      <span aria-hidden="true" style={{ color: 'var(--warn)' }}>★</span>
      <strong>{displayRating}</strong>
      <span className="muted">
        · {ratingCount} {ratingCount === 1 ? 'review' : 'reviews'}
      </span>
    </span>
  );
}
