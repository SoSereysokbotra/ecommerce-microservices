'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, getToken } from '@/lib/api';
import { useCart } from '@/components/CartProvider';
import { formatMoney, type Order, type Product } from '@/lib/types';

export default function CartPage() {
  const router = useRouter();
  const { items, loading, adjustments, dismissAdjustments, setQty, removeItem, clear } = useCart();

  // The cart stores product ids and quantities only — never prices, so it can
  // never show a stale one. Names and prices are read from catalog here.
  const [products, setProducts] = useState<Record<string, Product>>({});
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

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

  const priced = items.map((line) => ({ ...line, product: products[line.productId] }));
  const currency = priced.find((line) => line.product)?.product?.currency ?? 'USD';
  const total = priced.reduce(
    (sum, line) => sum + (line.product ? line.product.priceMinor * line.qty : 0),
    0,
  );

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
            <strong>Total</strong>
            <strong className="price" data-testid="cart-total">
              {formatMoney(total, currency)}
            </strong>
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
