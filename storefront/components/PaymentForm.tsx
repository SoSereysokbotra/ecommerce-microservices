'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { useMemo, useState } from 'react';

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

// NEXT_PUBLIC_ variables are compiled into the JavaScript every visitor
// downloads. A secret key here would be published to the world, so fail loudly
// rather than quietly shipping one. Confusing the two keys is an easy mistake:
// they differ by three characters and sit next to each other in the dashboard.
if (publishableKey && !publishableKey.startsWith('pk_')) {
  throw new Error(
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must be a publishable key (pk_...). ' +
      'A secret key (sk_...) must never reach the browser — it can read every ' +
      'payment and issue refunds.',
  );
}

/**
 * Card entry, hosted by Stripe.
 *
 * The card number is captured inside Stripe's iframe and never reaches our
 * servers or this bundle — that is what keeps the project in PCI SAQ-A. Never
 * replace this with a plain <input> posting to our API.
 */
function Form({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setBusy(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });

    if (result.error) {
      // Shown for the customer's benefit. The authoritative outcome still
      // arrives as a webhook — this is only the browser's view of it.
      setError(result.error.message ?? 'Payment failed');
      setBusy(false);
      return;
    }

    onPaid();
  }

  return (
    <form onSubmit={submit} className="stack">
      <PaymentElement />
      <div className="row">
        <button type="submit" disabled={!stripe || busy}>
          {busy ? 'Paying…' : 'Pay now'}
        </button>
        <span className="small muted">Test card 4242 4242 4242 4242 · any future date · any CVC</span>
      </div>
      {error && <div className="notice crit small">{error}</div>}
    </form>
  );
}

export function PaymentForm({ clientSecret, onPaid }: { clientSecret: string; onPaid: () => void }) {
  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [],
  );

  if (!stripePromise) {
    return (
      <div className="notice crit small">
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set, so the payment form cannot load.
      </div>
    );
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <Form onPaid={onPaid} />
    </Elements>
  );
}
