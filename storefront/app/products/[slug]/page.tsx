'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, getToken } from '@/lib/api';
import { formatMoney, type Order, type Product, type Stock } from '@/lib/types';

export default function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();

  const [product, setProduct] = useState<Product | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const p = await api.get<Product>(`/catalog/products/${slug}`);
        setProduct(p);
        const rows = await api.get<Stock[]>(`/inventory/stock?productIds=${p.id}`);
        setAvailable(rows[0]?.availableQty ?? 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [slug]);

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

  if (error && !product) return <div className="notice crit">{error}</div>;
  if (!product) return <p className="muted">Loading…</p>;

  const outOfStock = available !== null && available <= 0;

  return (
    <>
      <p className="small">
        <Link href="/">← All products</Link>
      </p>

      <h1>{product.name}</h1>
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
          <button onClick={placeOrder} disabled={placing || outOfStock}>
            {placing ? 'Placing…' : 'Buy now'}
          </button>
        </div>

        {error && <div className="notice crit small">{error}</div>}

        <p className="small muted">
          Placing an order reserves the stock, then asks for payment. If payment
          fails the reservation is released automatically.
        </p>
      </div>
    </>
  );
}
