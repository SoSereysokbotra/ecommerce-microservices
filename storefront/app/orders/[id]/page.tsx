'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney, type Order, type OrderStatus, type Payment } from '@/lib/types';
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

  return (
    <>
      <p className="small">
        <Link href="/">← All products</Link>
      </p>

      <h1>Order</h1>
      <p className="small muted" style={{ fontFamily: 'ui-monospace, monospace' }}>{order.id}</p>

      <div className="row" style={{ margin: '1rem 0' }}>
        <span className={`pill ${PILL[order.status]}`}>{order.status.replace('_', ' ')}</span>
        <span className="muted">{EXPLAIN[order.status]}</span>
      </div>

      {order.failureReason && (
        <div className="notice crit small">
          <strong>Reason:</strong> {order.failureReason}
        </div>
      )}

      {order.status === 'cancelled' && (
        <div className="notice ok small" style={{ marginTop: '0.75rem' }}>
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
              <td className="num">{formatMoney(i.unitPriceMinor, order.currency)}</td>
              <td className="num">{formatMoney(i.unitPriceMinor * i.qty, order.currency)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong>{formatMoney(order.totalMinor, order.currency)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

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
