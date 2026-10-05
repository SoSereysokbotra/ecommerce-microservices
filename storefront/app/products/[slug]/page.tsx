'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, getToken } from '@/lib/api';
import { useCart } from '@/components/CartProvider';
import {
  formatMoney,
  type Eligibility,
  type Order,
  type Product,
  type ReviewsPage,
  type Stock,
} from '@/lib/types';
import { Stars } from '@/components/Stars';

export default function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();

  const [product, setProduct] = useState<Product | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [added, setAdded] = useState(false);

  // Lazy initializer for token to avoid synchronous setState inside an effect
  // (React 19 / Next 16 discipline; see CurrencySwitcher).
  const [token] = useState<string | null>(() => getToken());

  // Reviews and eligibility state (docs/M13_REVIEWS_PLAN.md §6, §7)
  const [reviewsPage, setReviewsPage] = useState<ReviewsPage | null>(null);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);

  // Create review form state
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Edit review form state
  const [editing, setEditing] = useState(false);
  const [editRating, setEditRating] = useState(5);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [updating, setUpdating] = useState(false);

  const { addItem } = useCart();

  useEffect(() => {
    (async () => {
      try {
        const p = await api.get<Product>(`/catalog/products/${slug}`);
        setProduct(p);
        const rows = await api.get<Stock[]>(`/inventory/stock?productIds=${p.id}`);
        setAvailable(rows[0]?.availableQty ?? 0);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [slug]);

  /**
   * Fetch approved reviews (public, newest first) and eligibility (if signed in).
   *
   * Asynchronous setState only after await and guarded by cancellation,
   * satisfying React 19's rule against synchronous effect setState.
   */
  useEffect(() => {
    if (!product) return;
    let cancelled = false;

    void (async () => {
      try {
        const rev = await api.get<ReviewsPage>(`/reviews/products/${product.id}`);
        if (!cancelled) setReviewsPage(rev);
      } catch {
        /* reviews service offline or temporary network issue */
      }

      if (token) {
        try {
          const el = await api.get<Eligibility>(`/reviews/products/${product.id}/eligibility`);
          if (!cancelled) setEligibility(el);
        } catch {
          /* unauthenticated or failed eligibility call */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [product, token]);

  // The rating comes from reviews-service, which owns it. Deriving it here
  // from `items` would average only the page on screen while showing the
  // product's full count — a different number on page 2, and a second
  // implementation of a figure that already has an owner (ADR-0007).
  const avgE2 = reviewsPage?.rating?.avgE2 ?? null;
  const ratingCount = reviewsPage?.rating?.count ?? 0;

  async function addToCart() {
    if (!product) return;

    setError(null);
    setAdded(false);

    try {
      // No login required: an anonymous shopper gets a guest cart, and it is
      // merged into their account's cart when they sign in.
      await addItem(product.id, qty);
      setAdded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function placeOrder() {
    if (!product) return;

    if (!getToken()) {
      router.push('/login');
      return;
    }

    setPlacing(true);
    setError(null);

    try {
      // Returns immediately with status `pending` — checkout is asynchronous
      // now. The order page shows the saga progressing.
      const order = await api.post<Order>('/orders', {
        items: [{ productId: product.id, qty }],
      });
      router.push(`/orders/${order.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.push('/login');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPlacing(false);
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!product) return;

    setSubmitting(true);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await api.post(`/reviews/products/${product.id}`, {
        rating,
        title: title.trim(),
        body: body.trim(),
      });
      setReviewSuccess('Review submitted! It will appear once approved by moderation.');
      setTitle('');
      setBody('');
      setRating(5);
      // Re-query eligibility: customer now has an existing review awaiting moderation
      const el = await api.get<Eligibility>(`/reviews/products/${product.id}/eligibility`);
      setEligibility(el);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function startEditing() {
    setEditing(true);
    setReviewError(null);
    setReviewSuccess(null);
    const existingId = eligibility?.existing ?? eligibility?.existingReviewId;
    const found = reviewsPage?.items.find((r) => r.id === existingId);
    if (found) {
      setEditRating(found.rating);
      setEditTitle(found.title);
      setEditBody(found.body);
    } else {
      try {
        const mine =
          await api.get<{ id: string; rating: number; title: string; body: string }[]>(
            '/reviews/me',
          );
        const target = mine.find((r) => r.id === existingId);
        if (target) {
          setEditRating(target.rating);
          setEditTitle(target.title);
          setEditBody(target.body);
        }
      } catch {
        /* fallback to defaults */
      }
    }
  }

  async function submitEditReview(e: React.FormEvent) {
    e.preventDefault();
    const existingId = eligibility?.existing ?? eligibility?.existingReviewId;
    if (!existingId || !product) return;

    setUpdating(true);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await api.patch(`/reviews/${existingId}`, {
        rating: editRating,
        title: editTitle.trim(),
        body: editBody.trim(),
      });
      setReviewSuccess('Review updated! It returns to moderation before being published again.');
      setEditing(false);
      // Refresh eligibility and review list (edit resets status to pending and subtracts from rollup)
      const el = await api.get<Eligibility>(`/reviews/products/${product.id}/eligibility`);
      setEligibility(el);
      const rev = await api.get<ReviewsPage>(`/reviews/products/${product.id}`);
      setReviewsPage(rev);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  }

  if (notFound) {
    // A search hit can point here after the product was deactivated — the
    // index is a projection, seconds behind catalog at worst. Say that,
    // rather than showing a bare 404 for something the shopper just saw
    // listed (docs/M12_SEARCH_PLAN.md §7).
    return (
      <div className="notice" data-testid="product-gone">
        <strong>This product is no longer available.</strong>
        <p className="small muted" style={{ margin: '0.35rem 0 0' }}>
          It may still appear in search results for a moment.{' '}
          <Link href="/search">Back to search</Link> · <Link href="/">All products</Link>
        </p>
      </div>
    );
  }
  if (error && !product) return <div className="notice crit">{error}</div>;
  if (!product) return <p className="muted">Loading…</p>;

  const outOfStock = available !== null && available <= 0;

  return (
    <>
      <p className="small">
        <Link href="/">← All products</Link>
      </p>

      <h1>{product.name}</h1>
      <Stars ratingAvgE2={avgE2} ratingCount={ratingCount} />
      <p className="muted">{product.description}</p>

      <div className="stack" style={{ maxWidth: 420, marginTop: '1.5rem' }}>
        <div className="row">
          <span className="price" style={{ fontSize: '1.3rem' }}>
            {formatMoney(product.priceMinor, product.currency)}
          </span>
          {available !== null &&
            (outOfStock ? (
              <span className="pill crit">out of stock</span>
            ) : (
              <span className="pill ok">{available} available</span>
            ))}
        </div>

        <div className="row">
          <label htmlFor="qty" className="small muted">
            Quantity
          </label>
          <input
            id="qty"
            type="number"
            min={1}
            max={Math.max(available ?? 1, 1)}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
            style={{ width: 80 }}
          />
          <button onClick={addToCart} disabled={outOfStock} data-testid="add-to-cart">
            Add to cart
          </button>
          {/* Buy now is kept deliberately: it is the single-product path the
              Playwright suite drives, and removing it would rewrite those
              tests for no benefit. */}
          <button className="ghost" onClick={placeOrder} disabled={placing || outOfStock}>
            {placing ? 'Placing…' : 'Buy now'}
          </button>
        </div>

        {added && (
          <div className="notice small" data-testid="added-notice">
            Added to your cart. <Link href="/cart">View cart</Link>
          </div>
        )}

        {error && <div className="notice crit small">{error}</div>}

        <p className="small muted">
          Placing an order reserves the stock, then asks for payment. If payment fails the
          reservation is released automatically.
        </p>
      </div>

      {/* Customer reviews and eligibility section (docs/M13_REVIEWS_PLAN.md §7) */}
      <section
        style={{
          marginTop: '3rem',
          borderTop: '1px solid var(--line)',
          paddingTop: '2rem',
          maxWidth: 640,
        }}
        data-testid="reviews-section"
      >
        <h2>Customer reviews</h2>
        <div style={{ marginBottom: '1.5rem' }}>
          <Stars ratingAvgE2={avgE2} ratingCount={ratingCount} />
        </div>

        {/* Customer review form / edit link / explanation — only when signed in */}
        {token ? (
          <div style={{ marginBottom: '2rem' }}>
            {reviewSuccess && (
              <div className="notice ok small" style={{ marginBottom: '1rem' }}>
                {reviewSuccess}
              </div>
            )}
            {reviewError && (
              <div className="notice crit small" style={{ marginBottom: '1rem' }}>
                {reviewError}
              </div>
            )}

            {eligibility?.canReview && (
              <form
                onSubmit={submitReview}
                className="stack"
                style={{ gap: '0.75rem', maxWidth: 440 }}
                data-testid="review-form"
              >
                <h3>Write a review</h3>
                <label className="small">
                  Rating
                  <select
                    value={rating}
                    onChange={(e) => setRating(Number(e.target.value))}
                    data-testid="review-rating"
                  >
                    <option value="5">5 stars</option>
                    <option value="4">4 stars</option>
                    <option value="3">3 stars</option>
                    <option value="2">2 stars</option>
                    <option value="1">1 star</option>
                  </select>
                </label>
                <label className="small">
                  Title
                  <input
                    type="text"
                    maxLength={120}
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Summarise your experience"
                    data-testid="review-title"
                  />
                </label>
                <label className="small">
                  Review
                  <textarea
                    rows={4}
                    required
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="What did you think of this product?"
                    data-testid="review-body"
                  />
                </label>
                <button type="submit" disabled={submitting} data-testid="submit-review">
                  {submitting ? 'Submitting…' : 'Submit review'}
                </button>
              </form>
            )}

            {(eligibility?.existing || eligibility?.existingReviewId) && (
              <div className="stack" style={{ gap: '0.75rem' }} data-testid="review-existing">
                <p className="small muted">
                  You reviewed this —{' '}
                  <a
                    href="#edit-review"
                    onClick={(e) => {
                      e.preventDefault();
                      void startEditing();
                    }}
                    data-testid="edit-review-link"
                  >
                    edit your review
                  </a>
                </p>
                {editing && (
                  <form
                    onSubmit={submitEditReview}
                    className="stack"
                    style={{ gap: '0.75rem', maxWidth: 440 }}
                    data-testid="edit-review-form"
                  >
                    <h3>Edit your review</h3>
                    <label className="small">
                      Rating
                      <select
                        value={editRating}
                        onChange={(e) => setEditRating(Number(e.target.value))}
                        data-testid="edit-review-rating"
                      >
                        <option value="5">5 stars</option>
                        <option value="4">4 stars</option>
                        <option value="3">3 stars</option>
                        <option value="2">2 stars</option>
                        <option value="1">1 star</option>
                      </select>
                    </label>
                    <label className="small">
                      Title
                      <input
                        type="text"
                        maxLength={120}
                        required
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        data-testid="edit-review-title"
                      />
                    </label>
                    <label className="small">
                      Review
                      <textarea
                        rows={4}
                        required
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        data-testid="edit-review-body"
                      />
                    </label>
                    <div className="row">
                      <button type="submit" disabled={updating} data-testid="save-edit-review">
                        {updating ? 'Saving…' : 'Save changes'}
                      </button>
                      <button type="button" className="ghost" onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {eligibility &&
              !eligibility.canReview &&
              !eligibility.existing &&
              !eligibility.existingReviewId && (
                <p className="muted small" data-testid="cannot-review-reason">
                  {eligibility.reason}
                </p>
              )}
          </div>
        ) : null}

        {/* Approved reviews list (docs/M13_REVIEWS_PLAN.md §7) */}
        {reviewsPage && reviewsPage.items.length > 0 ? (
          <div className="stack" style={{ gap: '1rem' }} data-testid="reviews-list">
            {reviewsPage.items.map((r) => (
              <article
                key={r.id}
                className="card"
                style={{ gap: '0.35rem' }}
                data-testid="review-card"
              >
                <div
                  className="row"
                  style={{ justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ color: 'var(--warn)' }} aria-label={`${r.rating} out of 5 stars`}>
                    {'★'.repeat(r.rating)}
                    {'☆'.repeat(5 - r.rating)}
                  </span>
                  <span className="small muted">
                    {new Date(r.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <strong>{r.title}</strong>
                <span className="small muted">By {r.authorName}</span>
                <p style={{ margin: '0.35rem 0 0' }}>{r.body}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted small" data-testid="no-reviews">
            No reviews yet.
          </p>
        )}
      </section>
    </>
  );
}
