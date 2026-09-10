'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatAddress, type Address } from '@/lib/types';

/**
 * Choose where an order is going.
 *
 * This is what M8 left a placeholder for. Since then the tax destination has
 * travelled on the request and `RegionSelector` was the only thing choosing it,
 * because nothing in the system knew a customer's address. Now one does — and
 * the order sends the **address id**, so the country and region are read
 * server-side from a row this customer owns rather than taken from the browser.
 *
 * `RegionSelector` is not replaced. It is still right for a guest pricing a
 * basket before signing in, which M7 deliberately supports; this component only
 * renders for someone with an account. Two controls for two different states,
 * not two implementations of one.
 */
export function AddressPicker({
  value,
  onChange,
  onCount,
}: {
  value: string | null;
  onChange: (addressId: string, address: Address) => void;
  /**
   * How many addresses this customer has.
   *
   * The cart needs it to decide whether to *also* show the region selector: a
   * signed-in shopper with an empty address book would otherwise have no way to
   * choose a destination at all, which is worse than what M8 gave them. The
   * first version of this component did exactly that, and a pricing test that
   * signs in caught it.
   */
  onCount?: (count: number) => void;
}) {
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Every setState is inside the callback, never synchronously in the effect
    // body: React 19 flags that as a cascading render. Same pattern as the
    // cart page's quote effect.
    void (async () => {
      try {
        const saved = await api.get<Address[]>('/users/me/addresses');
        if (cancelled) return;

        setAddresses(saved);
        onCount?.(saved.length);

        // Pre-select the default, but only when nothing is chosen yet —
        // re-selecting it on every refetch would fight the shopper's choice.
        const preselect = saved.find((a) => a.isDefault) ?? saved[0];
        if (!value && preselect) {
          onChange(preselect.id, preselect);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately runs once. `value` and `onChange` are read inside, but
    // including them would refetch the list on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(form: HTMLFormElement) {
    const data = new FormData(form);
    const body = {
      label: String(data.get('label') ?? '') || null,
      recipient: String(data.get('recipient') ?? ''),
      line1: String(data.get('line1') ?? ''),
      line2: String(data.get('line2') ?? '') || null,
      city: String(data.get('city') ?? ''),
      region: String(data.get('region') ?? '') || null,
      postcode: String(data.get('postcode') ?? '') || null,
      country: String(data.get('country') ?? ''),
      // The first address a customer saves becomes their default anyway; this
      // makes a later one explicit when they ask for it.
      isDefault: data.get('isDefault') === 'on',
    };

    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Address>('/users/me/addresses', body);
      setAddresses((current) => {
        const next = [
          created,
          ...(current ?? []).map((a) => (created.isDefault ? { ...a, isDefault: false } : a)),
        ];
        onCount?.(next.length);
        return next;
      });
      onChange(created.id, created);
      setAdding(false);
      form.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (addresses === null && !error) return <p className="small muted">Loading addresses…</p>;

  return (
    <div className="stack" style={{ gap: '0.5rem' }} data-testid="address-picker">
      {error && <p className="small crit">{error}</p>}

      {(addresses ?? []).length > 0 && (
        <label className="row small" style={{ gap: '0.5rem', alignItems: 'center' }}>
          <span className="muted">Deliver to</span>
          <select
            data-testid="address-select"
            value={value ?? ''}
            onChange={(e) => {
              const chosen = (addresses ?? []).find((a) => a.id === e.target.value);
              if (chosen) onChange(chosen.id, chosen);
            }}
          >
            {!value && <option value="">Choose…</option>}
            {(addresses ?? []).map((address) => (
              <option key={address.id} value={address.id}>
                {address.label ? `${address.label} — ` : ''}
                {formatAddress(address)}
              </option>
            ))}
          </select>
        </label>
      )}

      {!adding ? (
        <button
          type="button"
          className="ghost small"
          data-testid="address-add"
          onClick={() => setAdding(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          {(addresses ?? []).length === 0 ? 'Add a delivery address' : 'Use a different address'}
        </button>
      ) : (
        <form
          className="stack"
          style={{ gap: '0.35rem', maxWidth: 360 }}
          data-testid="address-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(e.currentTarget);
          }}
        >
          <input name="label" placeholder="Label (Home, Work)" aria-label="Label" />
          <input name="recipient" placeholder="Recipient" aria-label="Recipient" required />
          <input name="line1" placeholder="Address line 1" aria-label="Address line 1" required />
          <input name="line2" placeholder="Address line 2" aria-label="Address line 2" />
          <input name="city" placeholder="City" aria-label="City" required />
          <div className="row" style={{ gap: '0.35rem' }}>
            <input
              name="region"
              placeholder="State / province"
              aria-label="State or province"
              style={{ width: 140 }}
            />
            <input name="postcode" placeholder="Postcode" aria-label="Postcode" style={{ width: 120 }} />
          </div>
          {/* Two letters, upper-cased server-side. The API rejects anything
              else outright, because a country that matches no tax rule and no
              shipping zone shows up as a wrong total rather than an error. */}
          <input
            name="country"
            placeholder="Country (US, DE)"
            aria-label="Country"
            maxLength={2}
            required
            style={{ width: 120 }}
          />
          <label className="row small" style={{ gap: '0.35rem', alignItems: 'center' }}>
            <input type="checkbox" name="isDefault" />
            <span className="muted">Make this my default</span>
          </label>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="submit" className="small" disabled={saving} data-testid="address-save">
              {saving ? 'Saving…' : 'Save address'}
            </button>
            <button type="button" className="ghost small" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
