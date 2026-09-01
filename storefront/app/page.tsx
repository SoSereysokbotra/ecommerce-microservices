'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney, type Product, type Stock } from '@/lib/types';

interface Page {
  data: Product[];
  nextCursor: string | null;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Both endpoints are public — browsing must not require an account.
        const page = await api.get<Page>('/catalog/products?limit=50');
        setProducts(page.data);

        const rows = await api.get<Stock[]>('/inventory/stock');
        setStock(Object.fromEntries(rows.map((r) => [r.productId, r.availableQty])));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="muted">Loading products…</p>;
  if (error) return <div className="notice crit">{error}</div>;

  return (
    <>
      <h1>Products</h1>
      <p className="muted">
        {products.length} items. Availability is live from the inventory service.
      </p>

      <div className="grid">
        {products.map((p) => {
          const available = stock[p.id];
          return (
            <article key={p.id} className="card">
              <Link href={`/products/${p.slug}`}>
                <strong>{p.name}</strong>
              </Link>
              <span className="small muted">{p.sku}</span>
              <span className="price">{formatMoney(p.priceMinor, p.currency)}</span>
              <span>
                {available === undefined ? (
                  <span className="pill info">stock unknown</span>
                ) : available > 0 ? (
                  <span className="pill ok">{available} in stock</span>
                ) : (
                  <span className="pill crit">out of stock</span>
                )}
              </span>
            </article>
          );
        })}
      </div>
    </>
  );
}
