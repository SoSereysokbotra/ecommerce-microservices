'use client';

import React from 'react';
import Link from 'next/link';
import { formatMoney, formatDate, getOrderStatusBadgeClass } from '@/lib/formatters';

export interface OrderItemSummary {
  id: string;
  customerId: string;
  status: string;
  totalMinor: number;
  currency: string;
  items: Array<{ productId: string; qty: number; name?: string }>;
  createdAt: string;
}

interface RecentOrdersTableProps {
  orders: OrderItemSummary[];
  loading: boolean;
}

export function RecentOrdersTable({ orders, loading }: RecentOrdersTableProps) {
  if (loading) {
    return (
      <div className="card" style={{ marginTop: '1.5rem', textAlign: 'center', padding: '2.5rem' }}>
        <p className="subtitle">Loading recent order activity…</p>
      </div>
    );
  }

  if (!orders || orders.length === 0) {
    return (
      <div className="card" style={{ marginTop: '1.5rem', textAlign: 'center', padding: '2.5rem' }}>
        <h3>No Orders Yet</h3>
        <p className="subtitle">When customers place orders, they will appear in this real-time stream.</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: '1.5rem' }} data-testid="recent-orders-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <div>
          <h2>Recent Orders & Activity</h2>
          <p className="subtitle">Latest customer purchases across the platform</p>
        </div>

        <Link href="/orders" className="btn btn-secondary" style={{ fontSize: '0.8rem' }}>
          View All Orders →
        </Link>
      </div>

      <div className="table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>Status</th>
              <th>Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, 5).map((order) => {
              const itemCount = order.items?.reduce((sum, item) => sum + (item.qty || 1), 0) || 0;
              return (
                <tr key={order.id} id={`row-order-${order.id}`}>
                  <td>
                    <code style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)' }}>
                      {order.id.slice(0, 8)}…
                    </code>
                  </td>
                  <td>
                    <span style={{ fontSize: '0.85rem' }}>
                      {order.customerId.slice(0, 8)}…
                    </span>
                  </td>
                  <td>{itemCount} item(s)</td>
                  <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {formatMoney(order.totalMinor, order.currency)}
                  </td>
                  <td>
                    <span className={`pill ${getOrderStatusBadgeClass(order.status)}`}>
                      {order.status}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {formatDate(order.createdAt)}
                  </td>
                  <td>
                    <Link
                      href={`/orders?id=${order.id}`}
                      className="btn btn-secondary"
                      style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                    >
                      Inspect
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
