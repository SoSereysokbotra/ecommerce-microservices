'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  SHIPMENT_LABELS,
  formatAddress,
  formatMoney,
  type Order,
  type OrderStatus,
  type Payment,
  type Shipment,
} from '@/lib/types';
import { PaymentForm } from '@/components/PaymentForm';

const TERMINAL: OrderStatus[] = ['confirmed', 'cancelled', 'failed'];

const EXPLAIN: Record<OrderStatus, string> = {
  pending: 'Reserving stock…',
  awaiting_payment: 'Stock is held for you. Payment is next.',
  confirmed: 'Paid and confirmed. The stock has left inventory.',
  cancelled: 'Cancelled. Any stock held for this order has been released.',
  failed: 'Something went wrong.',
};

const PILL: Record<OrderStatus, string> = {
  pending: 'info',
  awaiting_payment: 'warn',
  confirmed: 'ok',
  cancelled: 'crit',
  failed: 'crit',
};

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [order, setOrder] = useState<Order | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const o = await api.get<Order>(`/orders/${id}`);
      setOrder(o);

      // The payment only exists once the saga has reserved stock and asked for
      // it, so a 404 here is expected early on rather than an error.
      if (o.status === 'awaiting_payment') {
        try {
          setPayment(await api.get<Payment>(`/payments/by-order/${id}`));
        } catch {
          /* not created yet */
        }
      }

      /**
       * The parcel, once there is one.
       *
       * A shipment is created by shipping-service consuming `order.confirmed`,
       * which happens moments *after* the order reaches that status — so a 404
       * here is the normal state for the first second or two, not an error.
       *
       * Note this keeps polling after the order is terminal. The order is done;
       * the delivery is not. That is the whole point of the milestone: a
       * shipment outlives the request, and the saga, that created it.
       */
      if (o.status === 'confirmed') {
        try {
          const s = await api.get<Shipment>(`/shipping/shipments/${id}`);
          setShipment(s);
          if (s.status !== 'delivered') {
            timer.current = setTimeout(poll, 5000);
          }
        } catch {
          // Not created yet. Come back sooner than the delivery poll would.
          timer.current = setTimeout(poll, 1500);
        }
        return;
      }

      if (!TERMINAL.includes(o.status)) {
        timer.current = setTimeout(poll, 1500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void poll();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  if (error) return <div className="notice crit">{error}</div>;
  if (!order) return <p className="muted">Loading order…</p>;

  /**
   * The order is rendered in the currency it was **placed** in, always.
   *
   * The header's switcher does not apply here. An order is a record of what
   * was agreed; a shopper who switches to euros must not see last month's
   * dollar order restated, and a yen order must not grow two decimal places.
   * The exponent is read off the order for the same reason the rate is —
   * nothing about displaying a historical order may depend on a table that can
   * change. Null means placed before M11, when two was the only answer.
   */
  const exponent = order.exponent ?? 2;

  return (
    <>
      <p className="small">
        <Link href="/">← All products</Link>
      </p>

      <h1>Order</h1>
      <p className="small muted" style={{ fontFamily: 'ui-monospace, monospace' }}>{order.id}</p>

      <div className="row" style={{ margin: '1rem 0' }}>
        <span className={`pill ${PILL[order.status]}`} data-testid="order-status">
          {order.status.replace('_', ' ')}
        </span>
        <span className="muted">{EXPLAIN[order.status]}</span>
      </div>

      {order.failureReason && (
        <div className="notice crit small" data-testid="failure-reason">
          <strong>Reason:</strong> {order.failureReason}
        </div>
      )}

      {order.status === 'cancelled' && (
        <div className="notice ok small" style={{ marginTop: '0.75rem' }} data-testid="release-notice">
          The stock reserved for this order was released automatically — no
          manual cleanup, and nothing is left held. That compensation is the
          whole point of the saga.
        </div>
      )}

      <table style={{ marginTop: '1.5rem' }}>
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Unit</th>
            <th className="num">Line</th>
          </tr>
        </thead>
        <tbody>
          {order.items?.map((i) => (
            <tr key={i.id}>
              <td>
                {i.name} <span className="small muted">{i.sku}</span>
              </td>
              <td className="num">{i.qty}</td>
              <td className="num">{formatMoney(i.unitPriceMinor, order.currency, exponent)}</td>
              <td className="num">{formatMoney(i.unitPriceMinor * i.qty, order.currency, exponent)}</td>
            </tr>
          ))}
          {/* The stored breakdown, never a recomputed one. These numbers were
              frozen onto the order when it was placed; a tax rate or promotion
              changing tomorrow must not move what this customer was charged. */}
          <tr>
            <td colSpan={3} className="muted">
              Subtotal
            </td>
            <td className="num" data-testid="order-subtotal">
              {formatMoney(order.subtotalMinor, order.currency, exponent)}
            </td>
          </tr>
          {order.discountMinor > 0 && (
            <tr>
              <td colSpan={3} className="muted">
                Discount
              </td>
              <td className="num" data-testid="order-discount">
                −{formatMoney(order.discountMinor, order.currency, exponent)}
              </td>
            </tr>
          )}
          {(order.shippingMinor > 0 || order.shippingRateCode) && (
            <tr>
              <td colSpan={3} className="muted">
                Shipping
                {order.shippingRateCode && (
                  <span className="small muted"> ({order.shippingRateCode})</span>
                )}
              </td>
              <td className="num" data-testid="order-shipping">
                {order.shippingMinor === 0
                  ? 'Free'
                  : formatMoney(order.shippingMinor, order.currency, exponent)}
              </td>
            </tr>
          )}
          <tr>
            <td colSpan={3} className="muted">
              Tax
              {order.taxCountry && (
                <span className="small muted">
                  {' '}
                  ({order.taxCountry}
                  {order.taxRegion ? `-${order.taxRegion}` : ''})
                </span>
              )}
            </td>
            <td className="num" data-testid="order-tax">
              {formatMoney(order.taxMinor, order.currency, exponent)}
            </td>
          </tr>
          {order.baseCurrency && order.baseCurrency !== order.currency && order.fxRateE8 && (
            <tr>
              <td colSpan={4} className="small muted" data-testid="order-fx-note">
                Converted from {order.baseCurrency} at {(order.fxRateE8 / 1e8).toFixed(4)}, the
                rate on the day. This order will not change if the rate does.
              </td>
            </tr>
          )}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong data-testid="order-total">
                {formatMoney(order.totalMinor, order.currency, exponent)}
              </strong>
            </td>
          </tr>
        </tbody>
      </table>

      {/**
        * The delivery.
        *
        * Rendered from shipping-service, not from the order, because the parcel
        * is a different aggregate with a different lifetime — the order is
        * finished at `confirmed`, and this goes on changing for days. That is
        * also why the order never gains a `FULFILLED` status: delivery is a
        * shipping fact, and letting a finished saga's order move again would be
        * worse than reading it from the service that owns it.
        */}
      {order.status === 'confirmed' && (
        <section style={{ marginTop: '2rem' }} data-testid="shipment">
          <h2>Delivery</h2>
          {shipment ? (
            <div className="stack" style={{ gap: '0.35rem' }}>
              <p>
                <span className={`pill ${shipment.status === 'delivered' ? 'ok' : 'info'}`}>
                  <span data-testid="shipment-status">{SHIPMENT_LABELS[shipment.status]}</span>
                </span>
              </p>
              {shipment.address && (
                <p className="small muted" data-testid="shipment-address">
                  {formatAddress(shipment.address)}
                </p>
              )}
              {shipment.trackingCode && (
                <p className="small" data-testid="shipment-tracking">
                  {shipment.carrier ?? 'Carrier'}: {shipment.trackingCode}
                </p>
              )}
            </div>
          ) : (
            <p className="muted small">Preparing your parcel…</p>
          )}
        </section>
      )}

      {order.status === 'awaiting_payment' && payment?.clientSecret && (
        <section style={{ marginTop: '2rem', maxWidth: 480 }}>
          <h2>Pay</h2>
          <PaymentForm
            clientSecret={payment.clientSecret}
            onPaid={() => {
              // Deliberately does NOT mark the order paid. Stripe's webhook is
              // the authority; the page keeps polling until the saga says so.
              void poll();
            }}
          />
        </section>
      )}

      {order.status === 'awaiting_payment' && !payment?.clientSecret && (
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Preparing payment…
        </p>
      )}
    </>
  );
}
