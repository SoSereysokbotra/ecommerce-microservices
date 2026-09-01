# Storefront

Customer-facing UI for the commerce microservices. Next.js, port 3100.

## Running

```bash
npm run dev          # http://localhost:3100
```

Needs `.env.local` (copy `.env.local.example`):

- `NEXT_PUBLIC_API_URL` — the gateway, `http://localhost:3000/api/v1`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — **`pk_test_...`**, never `sk_...`

`NEXT_PUBLIC_` variables are compiled into the JavaScript every visitor
downloads. A secret key there would be published to the world, so the payment
component throws at load if the value does not start with `pk_`.

## What the pages prove

`/orders/[id]` polls every 1.5s while the order is not terminal. That is the
asynchronous saga made visible: `pending` -> `awaiting_payment` ->
`confirmed` or `cancelled`. When an order is cancelled the page says the stock
was released automatically, because that compensation is the thing worth
showing.

When Stripe confirms a payment in the browser, the page deliberately does *not*
mark the order paid. The webhook is the authority; the browser only ever sees
its own view, and a customer closing the tab must not change the outcome.

## End-to-end tests

Real browser, real stack, nothing mocked:

```bash
docker compose up -d                                   # from the repo root
stripe listen --forward-to localhost:3005/api/v1/payments/webhook
npm run dev

export STRIPE_SECRET_KEY=sk_test_...                   # to drive test payments
npm run e2e
```

Five specs cover anonymous browsing, the login redirect, a successful purchase,
a declined card returning the stock, and an oversized order that is never
charged.

They are **not** in CI: they need six services, five databases and a Stripe
webhook tunnel. Running them in CI would mean either mocking the backend —
which would prove nothing about the saga — or standing the whole stack up,
which belongs with the deployment work in M22.
