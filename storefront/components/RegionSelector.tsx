'use client';

import { useEffect, useState } from 'react';
import { api, getDestination, setDestination, type StoredDestination } from '@/lib/api';
import type { TaxRate } from '@/lib/types';

/**
 * Where the basket is taxed.
 *
 * This exists because nothing in the system knows a customer's address until
 * M10 — the destination travels on the request, so somebody has to choose it.
 * It is also what makes M8's acceptance criterion demonstrable: one basket,
 * three regions, three totals, live in a browser.
 *
 * The options are read from `GET /pricing/tax-rates` rather than hardcoded, so
 * adding a region is a seed change and not a frontend change.
 */
export function RegionSelector({
  value,
  onChange,
}: {
  value: StoredDestination | null;
  onChange: (destination: StoredDestination) => void;
}) {
  const [options, setOptions] = useState<StoredDestination[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const rates = await api.get<TaxRate[]>('/pricing/tax-rates');

        // A country/region may have several rules — a general rate plus a
        // category exemption — and they are one choice to the shopper, so
        // collapse them and describe the destination by its broadest rate.
        const byKey = new Map<string, { destination: StoredDestination; label: string }>();
        for (const rate of rates) {
          const key = `${rate.country}${rate.region ? `-${rate.region}` : ''}`;
          const existing = byKey.get(key);
          if (existing && rate.category !== null) continue;
          byKey.set(key, {
            destination: { country: rate.country, region: rate.region },
            label: `${key} — ${rate.name}`,
          });
        }

        const sorted = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
        setOptions(sorted.map(([, v]) => v.destination));
        setLabels(Object.fromEntries(sorted.map(([k, v]) => [k, v.label])));
      } catch {
        // A quote still works without this — pricing falls back to the store
        // default — so a failed lookup hides the control rather than the page.
        setOptions([]);
      }
    })();
  }, []);

  if (options.length === 0) return null;

  const keyOf = (d: StoredDestination | null) =>
    d ? `${d.country}${d.region ? `-${d.region}` : ''}` : '';

  return (
    <label className="row small" style={{ gap: '0.5rem', alignItems: 'center' }}>
      <span className="muted">Deliver to</span>
      <select
        data-testid="region-selector"
        value={keyOf(value)}
        onChange={(e) => {
          const chosen = options.find((o) => keyOf(o) === e.target.value);
          if (chosen) onChange(chosen);
        }}
      >
        {value === null && <option value="">Choose…</option>}
        {options.map((o) => (
          <option key={keyOf(o)} value={keyOf(o)}>
            {labels[keyOf(o)] ?? keyOf(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The stored destination, as React state.
 *
 * A **lazy initializer** rather than a read in `useEffect` — the pattern Next 16
 * documents for persisted UI state (`preventing-flash-before-hydration`), and
 * the one `react-hooks/set-state-in-effect` requires. `getDestination()` returns
 * null during server rendering, and the selector renders nothing until its
 * options have loaded, so there is no markup for the two to disagree about.
 */
export function useDestination(): [StoredDestination | null, (d: StoredDestination) => void] {
  const [destination, setLocal] = useState<StoredDestination | null>(() => getDestination());

  return [
    destination,
    (d: StoredDestination) => {
      setDestination(d);
      setLocal(d);
    },
  ];
}
