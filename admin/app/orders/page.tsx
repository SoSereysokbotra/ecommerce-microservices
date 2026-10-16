'use client';

import React, { Suspense, useEffect, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthGate } from '@/components/AuthGate';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatDate, getOrderStatusBadgeClass } from '@/lib/formatters';

// -------------------------------- Type Definitions --------------------------------

interface OrderAddress {
  recipient: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode?: string | null;
  country: string;
  phone?: string | null;
}

interface OrderItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineDiscountMinor: number;
  taxRateBp: number;
  taxMinor: number;
}

interface OrderRecord {
  id: string;
  customerId: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  shippingRateCode?: string | null;
  shippingAddress?: OrderAddress | null;
  totalMinor: number;
  exponent?: number | null;
  baseCurrency?: string | null;
  fxRateE8?: number | null;
  fxRateAt?: string | null;
  taxCountry?: string | null;
  taxRegion?: string | null;
  failureReason?: string | null;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

interface ShipmentRecord {
  id: string;
  orderId: string;
  customerId: string;
  status: 'pending' | 'dispatched' | 'delivered' | string;
  rateCode: string | null;
  costMinor: number;
  weightG: number;
  carrier: string | null;
  trackingCode: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaymentRecord {
  id: string;
  orderId: string;
  status: 'requires_payment' | 'authorized' | 'declined' | 'refunded' | string;
  amountMinor: number;
  currency: string;
  clientSecret?: string | null;
  failureReason?: string | null;
  createdAt: string;
}

// -------------------------------- Orders Page Component --------------------------------

function OrdersContent() {
  const searchParams = useSearchParams();
  const initialOrderId = searchParams.get('id');

  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'crit'; text: string } | null>(null);

  // Filters & Search
  const [search, setSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Selected Order Drawer State
  const [selectedOrder, setSelectedOrder] = useState<OrderRecord | null>(null);
  const [shipment, setShipment] = useState<ShipmentRecord | null>(null);
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const [detailsLoading, setDetailsLoading] = useState<boolean>(false);

  // Dispatch Form State
  const [carrierInput, setCarrierInput] = useState<string>('DHL Express');
  const [trackingCodeInput, setTrackingCodeInput] = useState<string>('');
  const [dispatching, setDispatching] = useState<boolean>(false);

  // Deliver Action State
  const [markingDelivered, setMarkingDelivered] = useState<boolean>(false);

  // Refund Modal State
  const [isRefundModalOpen, setIsRefundModalOpen] = useState<boolean>(false);
  const [refundReason, setRefundReason] = useState<string>('Customer support cancellation');
  const [refunding, setRefunding] = useState<boolean>(false);

  const [, startTransition] = useTransition();

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const data = await api.get<OrderRecord[]>('/orders');
      setOrders(data || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch global orders';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setLoading(false);
    }
  };

  // Inspect order details, loading linked shipment & payment records
  const inspectOrder = async (order: OrderRecord) => {
    setSelectedOrder(order);
    setDetailsLoading(true);
    setShipment(null);
    setPayment(null);
    setTrackingCodeInput(`TRK-${order.id.slice(0, 8).toUpperCase()}`);

    try {
      const [shipmentRes, paymentRes] = await Promise.allSettled([
        api.get<ShipmentRecord>(`/shipping/shipments/${order.id}`),
        api.get<PaymentRecord>(`/payments/by-order/${order.id}`),
      ]);

      if (shipmentRes.status === 'fulfilled') {
        setShipment(shipmentRes.value);
      }
      if (paymentRes.status === 'fulfilled') {
        setPayment(paymentRes.value);
      }
    } finally {
      setDetailsLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    let mounted = true;
    api
      .get<OrderRecord[]>('/orders')
      .then((data) => {
        if (!mounted) return;
        setOrders(data || []);
        setLoading(false);

        // If URL has ?id=<orderId>, auto inspect
        if (initialOrderId && data) {
          const match = data.find((o) => o.id === initialOrderId);
          if (match) {
            startTransition(() => {
              inspectOrder(match);
            });
          }
        }
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to fetch global orders';
        setFeedback({ type: 'crit', text: msg });
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [initialOrderId]);

  // Dispatch Shipment Action
  const handleDispatchShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipment) return;

    setDispatching(true);
    setFeedback(null);
    try {
      const updated = await api.post<ShipmentRecord>(
        `/shipping/shipments/${shipment.id}/dispatch`,
        {
          carrier: carrierInput.trim() || undefined,
          trackingCode: trackingCodeInput.trim() || undefined,
        },
      );
      setShipment(updated);
      setFeedback({
        type: 'ok',
        text: `Shipment for order ${selectedOrder?.id.slice(0, 8)} dispatched via ${updated.carrier ?? 'carrier'} (Tracking: ${updated.trackingCode ?? 'N/A'}).`,
      });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to dispatch shipment.';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setDispatching(false);
    }
  };

  // Mark Shipment Delivered Action
  const handleMarkDelivered = async () => {
    if (!shipment) return;

    setMarkingDelivered(true);
    setFeedback(null);
    try {
      const updated = await api.post<ShipmentRecord>(
        `/shipping/shipments/${shipment.id}/deliver`,
        {},
      );
      setShipment(updated);
      setFeedback({
        type: 'ok',
        text: `Shipment for order ${selectedOrder?.id.slice(0, 8)} marked as DELIVERED to recipient.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to mark shipment delivered.';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setMarkingDelivered(false);
    }
  };

  // Issue Payment Refund Action
  const handleIssueRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;

    setRefunding(true);
    setFeedback(null);
    try {
      await api.post(`/payments/refund`, {
        orderId: selectedOrder.id,
        reason: refundReason.trim(),
      });

      // Update local payment state to REFUNDED
      if (payment) {
        setPayment({ ...payment, status: 'refunded' });
      }

      setFeedback({
        type: 'ok',
        text: `Refund successfully processed for Order ${selectedOrder.id.slice(0, 8)} (${formatMoney(selectedOrder.totalMinor, selectedOrder.currency)}).`,
      });
      setIsRefundModalOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to process refund.';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setRefunding(false);
    }
  };

  // Filtered Orders
  const filteredOrders = orders.filter((order) => {
    // Status filter
    if (statusFilter !== 'all' && order.status.toLowerCase() !== statusFilter.toLowerCase()) {
      return false;
    }

    // Search query
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchId = order.id.toLowerCase().includes(q);
      const matchCustomer = order.customerId.toLowerCase().includes(q);
      const matchItems = order.items?.some(
        (i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q),
      );
      return matchId || matchCustomer || matchItems;
    }

    return true;
  });

  // KPI Calculations
  const totalOrders = orders.length;
  const confirmedCount = orders.filter((o) => o.status.toLowerCase() === 'confirmed').length;
  const pendingCount = orders.filter(
    (o) => o.status.toLowerCase() === 'pending' || o.status.toLowerCase() === 'awaiting_payment',
  ).length;
  const cancelledCount = orders.filter(
    (o) => o.status.toLowerCase() === 'cancelled' || o.status.toLowerCase() === 'failed',
  ).length;
  const totalRevenueUsd = orders
    .filter((o) => o.status.toLowerCase() === 'confirmed')
    .reduce((sum, o) => (o.currency.toUpperCase() === 'USD' ? sum + o.totalMinor : sum), 0);

  return (
    <div className="content-container">
      {/* Top Header */}
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}
      >
        <div>
          <h1>Global Orders & Fulfillment Console</h1>
          <p className="subtitle">
            Track customer checkouts, dispatch courier shipments, and process Stripe refunds.
          </p>
        </div>

        <button
          id="btn-refresh-orders"
          type="button"
          className="btn btn-secondary"
          onClick={fetchOrders}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : '↻ Refresh Orders'}
        </button>
      </div>

      {/* Global Feedback Banner */}
      {feedback && (
        <div
          className={`pill ${feedback.type === 'ok' ? 'pill-ok' : 'pill-crit'}`}
          style={{
            display: 'flex',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius-sm)',
            marginBottom: '1.5rem',
            fontSize: '0.85rem',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* KPI Overview Grid */}
      <div className="grid-kpi">
        <div className="card">
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
            Total Orders Logged
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800 }}>{totalOrders}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
            Across all customer accounts
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
            Confirmed & Ready
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--status-ok)' }}>
            {confirmedCount}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
            Stock held & payment secured
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
            Pending Payment / Processing
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--status-warn)' }}>
            {pendingCount}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
            Awaiting customer payment intent
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
            Confirmed USD Volume
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--accent-primary)' }}>
            {formatMoney(totalRevenueUsd, 'USD')}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
            {cancelledCount} cancelled / failed orders
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div
        className="card"
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div className="row" style={{ gap: '1rem', flex: 1, minWidth: '300px' }}>
          <input
            id="orders-search"
            type="text"
            placeholder="Search by Order ID, Customer UUID, or item SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: '220px' }}
          />

          <select
            id="orders-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ width: '190px' }}
          >
            <option value="all">All Statuses ({orders.length})</option>
            <option value="confirmed">Confirmed ({confirmedCount})</option>
            <option value="awaiting_payment">Awaiting Payment</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled ({cancelledCount})</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          Showing <strong>{filteredOrders.length}</strong> of {orders.length} orders
        </div>
      </div>

      {/* Orders Master Table */}
      <div className="table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Items & SKUs</th>
              <th style={{ textAlign: 'right' }}>Total Value</th>
              <th>Status</th>
              <th>Placed At</th>
              <th style={{ textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && orders.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}
                >
                  Loading enterprise order stream…
                </td>
              </tr>
            ) : filteredOrders.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}
                >
                  No orders match the current search or status filter.
                </td>
              </tr>
            ) : (
              filteredOrders.map((order) => {
                const totalUnits = order.items?.reduce((acc, i) => acc + (i.qty || 1), 0) || 0;
                const isForeignCurrency =
                  order.baseCurrency && order.currency !== order.baseCurrency;

                return (
                  <tr key={order.id} id={`row-order-${order.id}`}>
                    <td>
                      <code style={{ fontSize: '0.82rem', color: 'var(--accent-secondary)' }}>
                        {order.id.slice(0, 8)}…
                      </code>
                    </td>

                    <td>
                      <span
                        style={{
                          fontSize: '0.85rem',
                          fontFamily: 'monospace',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {order.customerId.slice(0, 8)}…
                      </span>
                    </td>

                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>
                        {totalUnits} item{totalUnits === 1 ? '' : 's'}
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-faint)',
                          maxWidth: '240px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {order.items?.map((i) => `${i.qty}x ${i.name}`).join(', ') ||
                          'No item details'}
                      </div>
                    </td>

                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                        {formatMoney(order.totalMinor, order.currency)}
                      </span>
                      {isForeignCurrency && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)' }}>
                          Base: {order.baseCurrency}
                        </div>
                      )}
                    </td>

                    <td>
                      <span className={`pill ${getOrderStatusBadgeClass(order.status)}`}>
                        {order.status}
                      </span>
                    </td>

                    <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {formatDate(order.createdAt)}
                    </td>

                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        id={`btn-inspect-${order.id}`}
                        className="btn btn-secondary"
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}
                        onClick={() => inspectOrder(order)}
                      >
                        Inspect & Fulfill →
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ======================= ORDER DETAILS DRAWER ======================= */}
      {selectedOrder && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            zIndex: 100,
            backdropFilter: 'blur(3px)',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '680px',
              height: '100vh',
              borderRadius: 0,
              padding: '2rem',
              backgroundColor: 'var(--bg-secondary)',
              boxShadow: '-10px 0 25px -5px rgba(0, 0, 0, 0.5)',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.5rem',
            }}
          >
            {/* Drawer Header */}
            <div
              className="row"
              style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
            >
              <div>
                <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <h2>Order Details</h2>
                  <span className={`pill ${getOrderStatusBadgeClass(selectedOrder.status)}`}>
                    {selectedOrder.status}
                  </span>
                </div>
                <p
                  className="subtitle"
                  style={{ fontFamily: 'monospace', fontSize: '0.8rem', marginTop: '0.2rem' }}
                >
                  ID: {selectedOrder.id}
                </p>
                <div
                  style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.2rem' }}
                >
                  Customer: <code>{selectedOrder.customerId}</code> • Placed:{' '}
                  {formatDate(selectedOrder.createdAt)}
                </div>
              </div>

              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.4rem 0.7rem' }}
                onClick={() => setSelectedOrder(null)}
              >
                ✕ Close
              </button>
            </div>

            {/* Failure Reason Alert (if present) */}
            {selectedOrder.failureReason && (
              <div
                style={{
                  backgroundColor: 'var(--status-crit-bg)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  padding: '0.75rem 1rem',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--status-crit)',
                  fontSize: '0.85rem',
                }}
              >
                <strong>Order Failure Reason:</strong> {selectedOrder.failureReason}
              </div>
            )}

            {/* Line Items Breakdown */}
            <div className="card" style={{ padding: '1rem', backgroundColor: 'var(--bg-surface)' }}>
              <h3 style={{ fontSize: '0.95rem', marginBottom: '0.75rem' }}>Purchased Items</h3>
              <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--line-subtle)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <th style={{ textAlign: 'left', paddingBottom: '0.5rem' }}>Product / SKU</th>
                    <th style={{ textAlign: 'right', paddingBottom: '0.5rem' }}>Qty</th>
                    <th style={{ textAlign: 'right', paddingBottom: '0.5rem' }}>Price</th>
                    <th style={{ textAlign: 'right', paddingBottom: '0.5rem' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrder.items?.map((item) => {
                    const lineSubtotal =
                      item.qty * item.unitPriceMinor - (item.lineDiscountMinor || 0);
                    return (
                      <tr
                        key={item.id || item.productId}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                      >
                        <td style={{ padding: '0.6rem 0' }}>
                          <div style={{ fontWeight: 600 }}>{item.name}</div>
                          <code style={{ fontSize: '0.75rem', color: 'var(--accent-secondary)' }}>
                            {item.sku}
                          </code>
                        </td>
                        <td style={{ textAlign: 'right', padding: '0.6rem 0' }}>{item.qty}</td>
                        <td style={{ textAlign: 'right', padding: '0.6rem 0' }}>
                          {formatMoney(item.unitPriceMinor, selectedOrder.currency)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '0.6rem 0', fontWeight: 600 }}>
                          {formatMoney(lineSubtotal, selectedOrder.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Financial Summary */}
              <div
                style={{
                  marginTop: '1rem',
                  paddingTop: '0.75rem',
                  borderTop: '1px solid var(--line-subtle)',
                  fontSize: '0.85rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Subtotal:</span>
                  <span>{formatMoney(selectedOrder.subtotalMinor, selectedOrder.currency)}</span>
                </div>
                {selectedOrder.discountMinor > 0 && (
                  <div
                    className="row"
                    style={{ justifyContent: 'space-between', color: 'var(--status-ok)' }}
                  >
                    <span>Discounts Applied:</span>
                    <span>-{formatMoney(selectedOrder.discountMinor, selectedOrder.currency)}</span>
                  </div>
                )}
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Shipping ({selectedOrder.shippingRateCode || 'Standard'}):
                  </span>
                  <span>{formatMoney(selectedOrder.shippingMinor, selectedOrder.currency)}</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Tax ({selectedOrder.taxCountry || 'Store Default'}):
                  </span>
                  <span>{formatMoney(selectedOrder.taxMinor, selectedOrder.currency)}</span>
                </div>
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    fontWeight: 700,
                    fontSize: '1.05rem',
                    borderTop: '1px solid var(--line-subtle)',
                    paddingTop: '0.5rem',
                    marginTop: '0.25rem',
                    color: 'var(--accent-primary)',
                  }}
                >
                  <span>Grand Total:</span>
                  <span>{formatMoney(selectedOrder.totalMinor, selectedOrder.currency)}</span>
                </div>
                {selectedOrder.baseCurrency &&
                  selectedOrder.currency !== selectedOrder.baseCurrency && (
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-faint)',
                        textAlign: 'right',
                      }}
                    >
                      Charged in {selectedOrder.currency} (Base catalog:{' '}
                      {selectedOrder.baseCurrency})
                    </div>
                  )}
              </div>
            </div>

            {/* Destination / Shipping Address */}
            {selectedOrder.shippingAddress && (
              <div
                className="card"
                style={{ padding: '1rem', backgroundColor: 'var(--bg-surface)' }}
              >
                <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Delivery Address</h3>
                <div style={{ fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-main)' }}>
                  <div>
                    <strong>{selectedOrder.shippingAddress.recipient}</strong>
                  </div>
                  <div>{selectedOrder.shippingAddress.line1}</div>
                  {selectedOrder.shippingAddress.line2 && (
                    <div>{selectedOrder.shippingAddress.line2}</div>
                  )}
                  <div>
                    {selectedOrder.shippingAddress.city}
                    {selectedOrder.shippingAddress.region
                      ? `, ${selectedOrder.shippingAddress.region}`
                      : ''}{' '}
                    {selectedOrder.shippingAddress.postcode || ''}
                  </div>
                  <div>{selectedOrder.shippingAddress.country}</div>
                  {selectedOrder.shippingAddress.phone && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      Tel: {selectedOrder.shippingAddress.phone}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ================= FULFILLMENT & SHIPMENT SECTION ================= */}
            <div
              className="card"
              style={{ padding: '1.25rem', backgroundColor: 'var(--bg-surface)' }}
            >
              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <h3 style={{ fontSize: '1rem' }}>Fulfillment & Logistics</h3>
                {shipment && (
                  <span
                    className={`pill ${shipment.status === 'delivered' ? 'pill-ok' : shipment.status === 'dispatched' ? 'pill-staff' : 'pill-warn'}`}
                  >
                    {shipment.status.toUpperCase()}
                  </span>
                )}
              </div>

              {detailsLoading ? (
                <p className="subtitle" style={{ fontSize: '0.85rem' }}>
                  Loading shipment details…
                </p>
              ) : shipment ? (
                <div className="stack" style={{ gap: '0.75rem' }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    <div>
                      Shipment ID: <code>{shipment.id}</code>
                    </div>
                    <div>
                      Rate Code: <strong>{shipment.rateCode || 'Standard'}</strong> • Weight:{' '}
                      {shipment.weightG}g
                    </div>
                    {shipment.carrier && (
                      <div>
                        Carrier: <strong>{shipment.carrier}</strong>
                      </div>
                    )}
                    {shipment.trackingCode && (
                      <div>
                        Tracking Code:{' '}
                        <code style={{ color: 'var(--accent-secondary)' }}>
                          {shipment.trackingCode}
                        </code>
                      </div>
                    )}
                    {shipment.dispatchedAt && (
                      <div>Dispatched: {formatDate(shipment.dispatchedAt)}</div>
                    )}
                    {shipment.deliveredAt && (
                      <div>Delivered: {formatDate(shipment.deliveredAt)}</div>
                    )}
                  </div>

                  {/* Actions depending on shipment status */}
                  {shipment.status === 'pending' && (
                    <form
                      onSubmit={handleDispatchShipment}
                      className="stack"
                      style={{
                        gap: '0.75rem',
                        marginTop: '0.5rem',
                        backgroundColor: 'var(--bg-secondary)',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                        Dispatch Parcel to Carrier
                      </div>
                      <div className="row" style={{ gap: '0.5rem' }}>
                        <input
                          type="text"
                          placeholder="Carrier (e.g. DHL Express)"
                          value={carrierInput}
                          onChange={(e) => setCarrierInput(e.target.value)}
                          style={{ flex: 1 }}
                          required
                        />
                        <input
                          type="text"
                          placeholder="Tracking Code"
                          value={trackingCodeInput}
                          onChange={(e) => setTrackingCodeInput(e.target.value)}
                          style={{ flex: 1 }}
                          required
                        />
                      </div>
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={dispatching}
                        id="btn-dispatch-shipment"
                      >
                        {dispatching ? 'Dispatching…' : '✓ Dispatch Parcel'}
                      </button>
                    </form>
                  )}

                  {shipment.status === 'dispatched' && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleMarkDelivered}
                        disabled={markingDelivered}
                        id="btn-mark-delivered"
                      >
                        {markingDelivered ? 'Updating…' : '✓ Mark as Delivered'}
                      </button>
                    </div>
                  )}

                  {shipment.status === 'delivered' && (
                    <div
                      className="pill pill-ok"
                      style={{ padding: '0.5rem 0.75rem', alignSelf: 'flex-start' }}
                    >
                      ✓ Parcel Delivered to Customer
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  No active shipment created yet. Shipments are automatically provisioned when order
                  is confirmed.
                </div>
              )}
            </div>

            {/* ================= PAYMENT & REFUND SECTION ================= */}
            <div
              className="card"
              style={{ padding: '1.25rem', backgroundColor: 'var(--bg-surface)' }}
            >
              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <h3 style={{ fontSize: '1rem' }}>Financial Settlement & Refunds</h3>
                {payment && (
                  <span
                    className={`pill ${payment.status === 'authorized' ? 'pill-ok' : payment.status === 'refunded' ? 'pill-warn' : 'pill-crit'}`}
                  >
                    {payment.status.toUpperCase()}
                  </span>
                )}
              </div>

              {detailsLoading ? (
                <p className="subtitle" style={{ fontSize: '0.85rem' }}>
                  Loading payment intent status…
                </p>
              ) : payment ? (
                <div className="stack" style={{ gap: '0.75rem' }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    <div>
                      Payment ID: <code>{payment.id}</code>
                    </div>
                    <div>
                      Settlement Amount:{' '}
                      <strong>{formatMoney(payment.amountMinor, payment.currency)}</strong>
                    </div>
                    <div>Captured At: {formatDate(payment.createdAt)}</div>
                    {payment.failureReason && (
                      <div style={{ color: 'var(--status-crit)', marginTop: '0.25rem' }}>
                        Error: {payment.failureReason}
                      </div>
                    )}
                  </div>

                  {/* Refund trigger */}
                  {payment.status === 'authorized' && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => setIsRefundModalOpen(true)}
                        id="btn-trigger-refund"
                      >
                        Issue Stripe Refund…
                      </button>
                    </div>
                  )}

                  {payment.status === 'refunded' && (
                    <div
                      className="pill pill-warn"
                      style={{ padding: '0.5rem 0.75rem', alignSelf: 'flex-start' }}
                    >
                      ✓ Payment has been refunded to the customer
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  No payment record found for this order.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= REFUND CONFIRMATION MODAL ================= */}
      {isRefundModalOpen && selectedOrder && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 110,
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '460px',
              padding: '1.75rem',
              backgroundColor: 'var(--bg-secondary)',
            }}
          >
            <h2>Confirm Payment Refund</h2>
            <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
              Are you sure you want to refund{' '}
              <strong>{formatMoney(selectedOrder.totalMinor, selectedOrder.currency)}</strong> for
              Order <code>{selectedOrder.id.slice(0, 8)}</code>?
            </p>

            <form onSubmit={handleIssueRefund} className="stack" style={{ gap: '1rem' }}>
              <label className="stack" style={{ gap: '0.3rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Refund Reason (Audit Log)
                </span>
                <input
                  id="refund-reason-input"
                  type="text"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="e.g. Defective merchandise, Customer return request"
                  maxLength={200}
                  required
                />
              </label>

              <div
                className="row"
                style={{ justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}
              >
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsRefundModalOpen(false)}
                  disabled={refunding}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={refunding}
                  id="btn-confirm-refund"
                >
                  {refunding ? 'Refunding via Stripe…' : 'Confirm & Refund'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function OrdersPage() {
  return (
    <AuthGate>
      <Suspense
        fallback={
          <div className="content-container">
            <p className="subtitle">Loading orders console…</p>
          </div>
        }
      >
        <OrdersContent />
      </Suspense>
    </AuthGate>
  );
}
