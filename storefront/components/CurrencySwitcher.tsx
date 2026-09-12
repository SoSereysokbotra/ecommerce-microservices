'use client';

import { useEffect, useState } from 'react';
import { api, getCurrency, setCurrency } from '@/lib/api';
import type { Currency } from '@/lib/types';

/**
 * Which currency to see prices in.
 *
 * In the header rather than on the cart page, because it is a global choice.
 * The options come from `GET /pricing/currencies`, so adding a currency is a
 * seed change and not a frontend change — the same reason `RegionSelector`
 * reads tax rates rather than hardcoding them.
 *
 * What this does NOT do: convert anything. The browser holds no rates and does
 * no arithmetic. The cart page sends the chosen code with the quote, pricing
 * converts server-side, and the exponent to format with comes back on the
 * response. A second implementation of conversion in the browser would be the
 * two-totals defect M8 removed, wearing a different hat.
 *
 * Product pages keep showing the catalog's base currency. Converting them would
 * need either a quote per product or client-side arithmetic; neither is worth
 * it for a listing, and the cart is where the number becomes binding. Noted in
 * ADR-0010.
 */
export function CurrencySwitcher() {
  const [options, setOptions] = useState<Currency[]>([]);
  // A lazy initializer, never a read inside an effect — the pattern Next 16
  // documents for persisted UI state, and what `react-hooks/set-state-in-effect`
  // requires. See `useDestination` in RegionSelector.
  const [value, setValue] = useState<string | null>(() => getCurrency());

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const currencies = await api.get<Currency[]>('/pricing/currencies');
        if (!cancelled) setOptions(currencies);
      } catch {
        // Pricing falls back to the base currency without this, so a failed
        // lookup hides the control rather than the page.
        if (!cancelled) setOptions([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (options.length === 0) return null;

  return (
    <label className="row small" style={{ gap: '0.35rem', alignItems: 'center' }}>
      <select
        data-testid="currency-switcher"
        aria-label="Currency"
        value={value ?? ''}
        onChange={(e) => {
          const next = e.target.value || null;
          setValue(next);
          setCurrency(next);
          // The cart page reads the stored value on mount, and its quote effect
          // keys on it. A full reload is the honest way to make every price on
          // whatever page this is re-quote — the alternative is a context that
          // every money-rendering component subscribes to, which is a refactor
          // M11 does not need.
          window.location.reload();
        }}
      >
        {value === null && <option value="">Currency…</option>}
        {options.map((currency) => (
          <option key={currency.code} value={currency.code}>
            {currency.code}
          </option>
        ))}
      </select>
    </label>
  );
}
