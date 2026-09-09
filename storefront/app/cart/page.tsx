'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, getToken } from '@/lib/api';
import { useCart } from '@/components/CartProvider';
import { RegionSelector, useDestination } from '@/components/RegionSelector';
import {
  COUPON_REJECTIONS,
  formatMoney,
  taxLabel,
  type Order,
  type Product,
  type Quote,
} from '@/lib/types';

export default function CartPage() {
  const router = useRouter();
  const { items, loading, adjustments, dismissAdjustments, setQty, removeItem, clear } = useCart();

  // The cart stores product ids and quantities only — never prices, so it can
  // never show a stale one. Names and prices are read from catalog here.
  const [products, setProducts] = useState<Record<string, Product>>({});
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  // The totals are no longer computed here. Summing prices in the browser was
  // a second implementation of "what does this basket cost" alongside
  // orders-service, and the way you find out they disagreed is a customer
  // seeing one number and being charged another. pricing-service answers both.
  const [destination, chooseDestination] = useDestination();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);

  // `couponCode` is what has been applied to the quote; `couponDraft` is what is
  // in the box. Keeping them apart means typing does not re-quote on every
  // keystroke — the shopper presses Apply, and only then does the basket
  // re-price. Quoting never spends a use, but it does cost a round trip.
  const [couponDraft, setCouponDraft] = useState('');
  const [couponCode, setCouponCode] = useState<string | null>(null);

  useEffect(() => {
    if (items.length === 0) return;

    (async () => {
      const missing = items.map((line) => line.productId).filter((id) => !products[id]);
      if (missing.length === 0) return;

      try {
        const all = await api.get<{ data: Product[] }>('/catalog/products?limit=100');
        const byId: Record<string, Product> = {};
        for (const product of all.data ?? []) {
          byId[product.id] = product;
        }
        setProducts((current) => ({ ...byId, ...current }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [items, products]);

  useEffect(() => {
    let cancelled = false;

    // Every setState lives inside this callback rather than the effect body:
    // React 19 flags synchronous setState in an effect as a cascading render.
    void (async () => {
      if (items.length === 0) {
        if (!cancelled) setQuote(null);
        return;
      }

      setQuoting(true);
      try {
        const next = await api.post<Quote>('/pricing/quote', {
          items: items.map((line) => ({ productId: line.productId, qty: line.qty })),
          ...(destination
            ? { destination: { country: destination.country, ...(destination.region ? { region: destination.region } : {}) } }
            : {}),
          ...(couponCode ? { couponCode } : {}),
        });
        // The basket may have changed while this was in flight; a stale quote
        // showing the wrong total is worse than showing none.
        if (!cancelled) setQuote(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setQuoting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [items, destination, couponCode]);

  const priced = items.map((line) => ({ ...line, product: products[line.productId] }));
  const currency = quote?.currency ?? priced.find((line) => line.product)?.product?.currency ?? 'USD';

  async function checkout() {
    if (!getToken()) {
      // The cart survives: it is merged into the account's on the first request
      // that carries both credentials.
      router.push('/login');
      return;
    }

    setPlacing(true);
    setError(null);

    try {
      const order = await api.post<Order>('/orders', {
        items: items.map((line) => ({ productId: line.productId, qty: line.qty })),
        // Sent so the order is taxed where the shopper was shown it would be.
        // Omitted when unset, and pricing applies the store default to both.
        ...(destination
          ? { destination: { country: destination.country, ...(destination.region ? { region: destination.region } : {}) } }
          : {}),
        // Unlike the quote above, this one claims a use.
        ...(couponCode && quote?.coupon?.applied ? { couponCode } : {}),
      });
      // The cart is emptied by cart-service consuming order.created, not here.
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

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Your cart</h1>

      {adjustments && adjustments.length > 0 && (
        <div className="notice" data-testid="merge-notice">
          <p className="small">
            We combined the cart you built before signing in with the one already on your account.
          </p>
          <ul className="small">
            {adjustments.map((adjustment) => (
              <li key={adjustment.productId}>
                {products[adjustment.productId]?.name ?? adjustment.productId}:{' '}
                {adjustment.reason === 'capped_to_stock' &&
                  `only ${adjustment.finalQty} left, so we reduced it from ${adjustment.requestedQty}`}
                {adjustment.reason === 'out_of_stock' && 'now out of stock, so we removed it'}
                {adjustment.reason === 'unavailable' && 'no longer sold, so we removed it'}
              </li>
            ))}
          </ul>
          <button className="ghost small" onClick={dismissAdjustments}>
            Dismiss
          </button>
        </div>
      )}

      {error && <div className="notice crit small">{error}</div>}

      {items.length === 0 ? (
        <p className="muted" data-testid="empty-cart">
          Nothing here yet. <Link href="/">Browse products</Link>.
        </p>
      ) : (
        <div className="stack" style={{ maxWidth: 560 }}>
          {priced.map((line) => (
            <div className="row" key={line.productId} data-testid="cart-line">
              <span style={{ flex: 1 }}>
                {line.product ? (
                  <Link href={`/products/${line.product.slug}`}>{line.product.name}</Link>
                ) : (
                  <span className="muted">{line.productId}</span>
                )}
              </span>

              <input
                type="number"
                min={0}
                value={line.qty}
                aria-label={`Quantity for ${line.product?.name ?? line.productId}`}
                onChange={(e) => void setQty(line.productId, Math.max(0, Number(e.target.value)))}
                style={{ width: 72 }}
              />

              <span className="price">
                {line.product ? formatMoney(line.product.priceMinor * line.qty, line.product.currency) : '—'}
              </span>

              <button className="ghost small" onClick={() => void removeItem(line.productId)}>
                Remove
              </button>
            </div>
          ))}

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <RegionSelector value={destination} onChange={chooseDestination} />
            {quoting && <span className="small muted">pricing…</span>}
          </div>

          <div className="stack" style={{ gap: '0.25rem' }}>
            <form
              className="row"
              style={{ gap: '0.5rem' }}
              onSubmit={(e) => {
                e.preventDefault();
                // Applying only re-quotes. The use is claimed at checkout, once.
                setCouponCode(couponDraft.trim() ? couponDraft.trim().toUpperCase() : null);
              }}
            >
              <input
                type="text"
                value={couponDraft}
                placeholder="Discount code"
                aria-label="Discount code"
                data-testid="coupon-input"
                onChange={(e) => setCouponDraft(e.target.value)}
                style={{ width: 160 }}
              />
              <button className="ghost small" type="submit" data-testid="coupon-apply">
                Apply
              </button>
              {couponCode && (
                <button
                  className="ghost small"
                  type="button"
                  data-testid="coupon-clear"
                  onClick={() => {
                    setCouponDraft('');
                    setCouponCode(null);
                  }}
                >
                  Remove
                </button>
              )}
            </form>

            {/* A refused code still prices the basket — it just says why it did
                not apply. "Invalid code" for every case is the version people
                complain about. */}
            {quote?.coupon && !quote.coupon.applied && (
              <p className="small crit" data-testid="coupon-error">
                {COUPON_REJECTIONS[quote.coupon.rejectedBecause ?? ''] ??
                  'That code could not be applied.'}
              </p>
            )}
            {quote?.coupon?.applied && (
              <p className="small muted" data-testid="coupon-applied">
                {quote.coupon.code} applied.
              </p>
            )}
          </div>

          <div className="stack" style={{ gap: '0.25rem' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Subtotal</span>
              <span className="price" data-testid="cart-subtotal">
                {quote ? formatMoney(quote.subtotalMinor, currency) : '—'}
              </span>
            </div>

            {quote?.appliedDiscounts.map((discount) => (
              <div
                className="row"
                style={{ justifyContent: 'space-between' }}
                key={discount.id}
                data-testid="cart-discount"
              >
                <span className="muted">{discount.name}</span>
                <span className="price" data-testid="cart-discount-amount">
                  −{formatMoney(discount.amountMinor, currency)}
                </span>
              </div>
            ))}

            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted" data-testid="cart-tax-label">
                {quote ? taxLabel(quote.taxBreakdown) : 'Tax'}
              </span>
              <span className="price" data-testid="cart-tax">
                {quote ? formatMoney(quote.taxMinor, currency) : '—'}
              </span>
            </div>

            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>Total</strong>
              <strong className="price" data-testid="cart-total">
                {quote ? formatMoney(quote.totalMinor, currency) : '—'}
              </strong>
            </div>

            {/* Inclusive tax means the total does not go up when it is added,
                which looks like a bug unless it is said out loud. */}
            {quote && quote.taxBreakdown.some((g) => g.pricesIncludeTax && g.rateBp > 0) && (
              <p className="small muted" data-testid="cart-tax-note">
                Prices include tax.
              </p>
            )}
          </div>

          <div className="row">
            <button onClick={checkout} disabled={placing} data-testid="checkout">
              {placing ? 'Placing…' : 'Checkout'}
            </button>
            <button className="ghost small" onClick={() => void clear()}>
              Empty cart
            </button>
          </div>

          <p className="small muted">
            Checkout reserves the stock, then asks for payment. If payment fails the reservation is
            released automatically.
          </p>
        </div>
      )}
    </>
  );
}
