'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  api,
  ApiError,
  getCurrency,
  getShippingChoice,
  getToken,
  setShippingChoice,
} from '@/lib/api';
import { useCart } from '@/components/CartProvider';
import { RegionSelector, useDestination } from '@/components/RegionSelector';
import { AddressPicker } from '@/components/AddressPicker';
import {
  COUPON_REJECTIONS,
  formatMoney,
  taxLabel,
  type Address,
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

  /**
   * Where it is going, and how fast.
   *
   * `signedIn` is read with a lazy initializer rather than in an effect —
   * `getToken()` touches localStorage, which does not exist during the server
   * render, and React 19 rejects a synchronous setState inside an effect. Same
   * pattern `useDestination` uses.
   *
   * A signed-in shopper picks a saved **address**, and the order sends its id
   * so the server reads the country and region itself. A guest still picks a
   * region, because they have no addresses and a cart page that cannot show a
   * total is not a cart page.
   */
  const [signedIn] = useState(() => getToken() !== null);
  // The header's choice. Sent with every quote and with the order; the browser
  // never converts anything itself.
  const [currencyChoice] = useState<string | null>(() => getCurrency());
  const [addressId, setAddressId] = useState<string | null>(() => getShippingChoice().addressId ?? null);
  const [address, setAddress] = useState<Address | null>(null);
  const [rateCode, setRateCode] = useState<string | null>(() => getShippingChoice().rateCode ?? null);

  /**
   * How many saved addresses this shopper has, or null while unknown.
   *
   * A signed-in shopper with an **empty** address book still needs the region
   * selector, or they cannot choose a destination at all — strictly worse than
   * what M8 gave them. Null while loading, so neither control flashes.
   */
  const [addressCount, setAddressCount] = useState<number | null>(null);

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
        // A chosen address decides the destination; the region selector is the
        // fallback for a guest. `POST /pricing/quote` takes no address id —
        // pricing does not read the address book — so the country and region
        // are sent here for display. The **order** sends the id, and the server
        // resolves it, which is what makes the figure binding.
        const quoteDestination = address
          ? { country: address.country, ...(address.region ? { region: address.region } : {}) }
          : destination
            ? { country: destination.country, ...(destination.region ? { region: destination.region } : {}) }
            : null;

        const next = await api.post<Quote>('/pricing/quote', {
          items: items.map((line) => ({ productId: line.productId, qty: line.qty })),
          ...(quoteDestination ? { destination: quoteDestination } : {}),
          ...(couponCode ? { couponCode } : {}),
          ...(rateCode ? { shippingRateCode: rateCode } : {}),
          ...(currencyChoice ? { currency: currencyChoice } : {}),
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
  }, [items, destination, address, couponCode, rateCode, currencyChoice]);

  const priced = items.map((line) => ({ ...line, product: products[line.productId] }));
  const currency = quote?.currency ?? priced.find((line) => line.product)?.product?.currency ?? 'USD';
  // Zero for JPY. Only the quote knows; the line prices below are catalog
  // figures in the base currency and format with the default until it lands.
  const exponent = quote?.exponent ?? 2;

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
        /**
         * The address **id**, not its contents.
         *
         * Orders reads the address itself, so the country and region come from
         * a row this customer owns rather than from a field this browser filled
         * in. Since M8 the client asserted the tax jurisdiction because nothing
         * knew a customer's address; this is where that stops.
         */
        ...(addressId ? { shippingAddressId: addressId } : {}),
        ...(rateCode ? { shippingRateCode: rateCode } : {}),
        // Charged in the currency the basket was shown in. The rate pricing
        // used is frozen onto the order, so this figure cannot move later.
        ...(currencyChoice ? { currency: currencyChoice } : {}),
        // Still sent, and still the only option for a guest checkout or an
        // account with no saved address. Ignored when an address id is given.
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
                {/* The quote's line, once it lands: that is the figure in the
                    chosen currency, and the one the total is built from. The
                    catalog price is the fallback for the moment before the
                    first quote — and it is the base currency, so a JPY shopper
                    would briefly see dollars. Better than seeing nothing. */}
                {(() => {
                  const quoted = quote?.lines.find((q) => q.productId === line.productId);
                  if (quoted) return formatMoney(quoted.lineSubtotalMinor, currency, exponent);
                  return line.product
                    ? formatMoney(line.product.priceMinor * line.qty, line.product.currency)
                    : '—';
                })()}
              </span>

              <button className="ghost small" onClick={() => void removeItem(line.productId)}>
                Remove
              </button>
            </div>
          ))}

          <div className="stack" style={{ gap: '0.5rem' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="stack" style={{ gap: '0.35rem' }}>
                {signedIn && (
                  <AddressPicker
                    value={addressId}
                    onCount={setAddressCount}
                    onChange={(id, chosen) => {
                      setAddressId(id);
                      setAddress(chosen);
                      setShippingChoice({ addressId: id, rateCode });
                    }}
                  />
                )}
                {/* Shown to a guest, and to anyone whose address book is still
                    empty. Not a duplicate control: once an address exists it is
                    what decides the destination, server-side. */}
                {(!signedIn || addressCount === 0) && (
                  <RegionSelector value={destination} onChange={chooseDestination} />
                )}
              </div>
              {quoting && <span className="small muted">pricing…</span>}
            </div>

            {/* Delivery speed. Rendered from the quote, so the prices shown are
                the ones already folded into the total — there is no second
                place computing what postage costs. */}
            {quote?.shipping && quote.shipping.options.length > 0 && (
              <label className="row small" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <span className="muted">Delivery</span>
                <select
                  data-testid="rate-selector"
                  value={quote.shipping.selectedCode ?? ''}
                  onChange={(e) => {
                    setRateCode(e.target.value);
                    setShippingChoice({ addressId, rateCode: e.target.value });
                  }}
                >
                  {quote.shipping.options.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.name} —{' '}
                      {option.costMinor === 0 ? 'Free' : formatMoney(option.costMinor, currency, exponent)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Express dropped out because the basket got heavier, and this
                browser was still holding the code. Say so rather than silently
                charging for standard. */}
            {quote?.shipping?.requestedCodeUnavailable && (
              <p className="small crit" data-testid="rate-unavailable">
                That delivery option is not available for this basket. We have used the cheapest
                one instead.
              </p>
            )}

            {quote?.shipping && quote.shipping.zone === null && (
              <p className="small crit" data-testid="no-shipping">
                We cannot deliver to that destination yet.
              </p>
            )}
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
                {quote ? formatMoney(quote.subtotalMinor, currency, exponent) : '—'}
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
                  −{formatMoney(discount.amountMinor, currency, exponent)}
                </span>
              </div>
            ))}

            {quote?.shipping && (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Shipping</span>
                {/* "Free" rather than "$0.00": a shopper who qualified for free
                    delivery should be told they did, not shown a zero. */}
                <span className="price" data-testid="cart-shipping">
                  {quote.shippingMinor === 0 ? 'Free' : formatMoney(quote.shippingMinor, currency, exponent)}
                </span>
              </div>
            )}

            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted" data-testid="cart-tax-label">
                {quote ? taxLabel(quote.taxBreakdown) : 'Tax'}
              </span>
              <span className="price" data-testid="cart-tax">
                {quote ? formatMoney(quote.taxMinor, currency, exponent) : '—'}
              </span>
            </div>

            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>Total</strong>
              <strong className="price" data-testid="cart-total">
                {quote ? formatMoney(quote.totalMinor, currency, exponent) : '—'}
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
