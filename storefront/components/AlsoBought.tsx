'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney, type Recommendation, type RecommendationsResponse } from '@/lib/types';

interface AlsoBoughtProps {
  productId: string;
}

/**
 * "Customers also bought" recommendation cards for the product page.
 *
 * Client component per docs/M14_RECOMMENDATIONS_PLAN.md §9 and §13 step 5.
 * Fetches the public recommendations endpoint:
 *   GET /recommendations/products/:productId?limit=4
 *
 * ## React 19 / Next 16 effect discipline
 *
 * Calling `setState` synchronously within an effect triggers
 * `react-hooks/set-state-in-effect`. State is updated only asynchronously
 * after `await api.get(...)` finishes, guarded by cancellation.
 *
 * ## Renders nothing on empty or failure
 *
 * When a product has no co-purchases (or if recommendations-service is
 * unavailable), this component renders `null` — no empty box, no heading.
 * An unranked product is the normal initial state, not an error worth showing.
 */
export function AlsoBought({ productId }: AlsoBoughtProps) {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await api.get<RecommendationsResponse>(
          `/recommendations/products/${productId}?limit=4`,
        );
        if (!cancelled) {
          setRecommendations(response?.items ?? []);
        }
      } catch {
        // Recommendations is non-critical discovery UI. On service failure or
        // network issue, render nothing rather than displaying an error notice.
        if (!cancelled) {
          setRecommendations([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (recommendations.length === 0) {
    return null;
  }

  return (
    <section
      style={{
        marginTop: '3rem',
        borderTop: '1px solid var(--line)',
        paddingTop: '2rem',
      }}
      data-testid="recommendations-section"
    >
      <h2>Customers also bought</h2>
      <div className="grid" style={{ marginTop: '1rem' }}>
        {recommendations.map((item) => (
          <article key={item.productId} className="card" data-testid="recommendation-card">
            <Link href={`/products/${item.slug}`}>
              <strong>{item.name}</strong>
            </Link>
            <span className="small muted">{item.sku}</span>
            <span className="price">{formatMoney(item.priceMinor, item.currency)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
