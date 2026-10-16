'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '@/components/AuthGate';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/formatters';
import { HealthMatrix } from '@/components/HealthMatrix';
import { RecentOrdersTable, OrderItemSummary } from '@/components/RecentOrdersTable';

interface DashboardMetrics {
  totalOrders: number;
  confirmedOrders: number;
  shippedOrders: number;
  deliveredOrders: number;
  cancelledOrders: number;
  grossRevenueMinor: number;
  primaryCurrency: string;
  totalUsers: number;
  activeUsers: number;
  staffUsers: number;
  trackedSkus: number;
  lowStockCount: number;
  outOfStockCount: number;
  pendingReviewsCount: number;
}

interface StockItem {
  productId: string;
  availableQty: number;
  reservedQty: number;
}

interface UsersResponse {
  items: Array<{ id: string; role: string; status: string }>;
  meta: { total: number };
}

interface ModerationResponse {
  items: unknown[];
  total: number;
}

export default function OverviewPage() {
  const { user, isAdmin } = useAuth();

  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalOrders: 0,
    confirmedOrders: 0,
    shippedOrders: 0,
    deliveredOrders: 0,
    cancelledOrders: 0,
    grossRevenueMinor: 0,
    primaryCurrency: 'USD',
    totalUsers: 0,
    activeUsers: 0,
    staffUsers: 0,
    trackedSkus: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
    pendingReviewsCount: 0,
  });

  const [recentOrders, setRecentOrders] = useState<OrderItemSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');

  const loadDashboardData = async (): Promise<{
    metrics: DashboardMetrics;
    orders: OrderItemSummary[];
  }> => {
    // 1. Fetch Orders
    let ordersList: OrderItemSummary[] = [];
    try {
      ordersList = await api.get<OrderItemSummary[]>('/orders');
    } catch {
      ordersList = [];
    }

    const totalOrders = ordersList.length;
    let confirmedOrders = 0;
    let shippedOrders = 0;
    let deliveredOrders = 0;
    let cancelledOrders = 0;
    let grossRevenueMinor = 0;
    let primaryCurrency = 'USD';

    ordersList.forEach((ord) => {
      const s = (ord.status || '').toUpperCase();
      if (s === 'CONFIRMED' || s === 'PAID') confirmedOrders++;
      else if (s === 'SHIPPED') shippedOrders++;
      else if (s === 'DELIVERED') deliveredOrders++;
      else if (s === 'CANCELLED') cancelledOrders++;

      if (s !== 'CANCELLED') {
        grossRevenueMinor += ord.totalMinor || 0;
      }
      if (ord.currency) {
        primaryCurrency = ord.currency;
      }
    });

    // 2. Fetch Users
    let usersData: UsersResponse | null = null;
    try {
      usersData = await api.get<UsersResponse>('/users?limit=100');
    } catch {
      usersData = null;
    }

    const totalUsers = usersData?.meta?.total ?? usersData?.items?.length ?? 0;
    const activeUsers =
      usersData?.items?.filter((u) => u.status === 'ACTIVE').length ?? 0;
    const staffUsers =
      usersData?.items?.filter(
        (u) => u.role === 'ADMIN' || u.role === 'STAFF'
      ).length ?? 0;

    // 3. Fetch Stock
    let stockList: StockItem[] = [];
    try {
      stockList = await api.get<StockItem[]>('/inventory/stock');
    } catch {
      stockList = [];
    }

    const trackedSkus = stockList.length;
    const outOfStockCount = stockList.filter((s) => s.availableQty <= 0).length;
    const lowStockCount = stockList.filter(
      (s) => s.availableQty > 0 && s.availableQty <= 5
    ).length;

    // 4. Fetch Moderation Queue
    let modData: ModerationResponse | null = null;
    try {
      modData = await api.get<ModerationResponse>(
        '/reviews/moderation?status=pending&limit=1'
      );
    } catch {
      modData = null;
    }
    const pendingReviewsCount = modData?.total ?? 0;

    return {
      orders: ordersList,
      metrics: {
        totalOrders,
        confirmedOrders,
        shippedOrders,
        deliveredOrders,
        cancelledOrders,
        grossRevenueMinor,
        primaryCurrency,
        totalUsers,
        activeUsers,
        staffUsers,
        trackedSkus,
        lowStockCount,
        outOfStockCount,
        pendingReviewsCount,
      },
    };
  };

  useEffect(() => {
    let mounted = true;
    void loadDashboardData().then((data) => {
      if (!mounted) return;
      setRecentOrders(data.orders);
      setMetrics(data.metrics);
      setLoading(false);
      setLastRefreshed(new Date().toLocaleTimeString());
    });

    return () => {
      mounted = false;
    };
  }, []);

  const handleManualRefresh = async () => {
    setLoading(true);
    try {
      const data = await loadDashboardData();
      setRecentOrders(data.orders);
      setMetrics(data.metrics);
      setLastRefreshed(new Date().toLocaleTimeString());
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthGate>
      <div className="stack" style={{ gap: '2rem' }}>
        {/* Header Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.25rem' }}>
              <h1>Operations Command Center</h1>
              <span
                className={`pill ${user?.role === 'ADMIN' ? 'pill-admin' : 'pill-staff'}`}
              >
                {user?.role} Active
              </span>
            </div>
            <p className="subtitle">
              Live metrics, fulfillment pipeline, and zero-trust perimeter observability.
            </p>
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            {lastRefreshed && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>
                Updated {lastRefreshed}
              </span>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleManualRefresh}
              disabled={loading}
              id="btn-refresh-metrics"
              style={{ fontSize: '0.8rem' }}
            >
              {loading ? 'Refreshing…' : '↻ Refresh Metrics'}
            </button>
          </div>
        </div>

        {/* KPI Cards Grid */}
        <div className="grid-kpi">
          {/* Revenue */}
          <div className="card kpi-card" id="kpi-revenue">
            <span className="kpi-label">Gross Revenue</span>
            <span className="kpi-value" style={{ color: 'var(--accent-primary)' }}>
              {formatMoney(metrics.grossRevenueMinor, metrics.primaryCurrency)}
            </span>
            <span className="kpi-hint">
              Across {metrics.totalOrders} total order(s) placed
            </span>
          </div>

          {/* Orders */}
          <div className="card kpi-card" id="kpi-orders">
            <span className="kpi-label">Fulfillment Queue</span>
            <span className="kpi-value">{metrics.confirmedOrders + metrics.shippedOrders}</span>
            <div className="row" style={{ gap: '0.4rem', marginTop: '0.2rem' }}>
              <span className="pill pill-ok">{metrics.confirmedOrders} Confirmed</span>
              <span className="pill pill-staff">{metrics.shippedOrders} Shipped</span>
            </div>
          </div>

          {/* Inventory */}
          <div className="card kpi-card" id="kpi-stock">
            <span className="kpi-label">Stock & Inventory</span>
            <span className="kpi-value">
              {metrics.trackedSkus}{' '}
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>SKUs</span>
            </span>
            <div className="row" style={{ gap: '0.4rem', marginTop: '0.2rem' }}>
              {metrics.outOfStockCount > 0 ? (
                <span className="pill pill-crit">{metrics.outOfStockCount} Out of Stock</span>
              ) : (
                <span className="pill pill-ok">No Zero-Stock</span>
              )}
              {metrics.lowStockCount > 0 && (
                <span className="pill pill-warn">{metrics.lowStockCount} Low Stock</span>
              )}
            </div>
          </div>

          {/* Moderation Queue */}
          <div className="card kpi-card" id="kpi-moderation">
            <span className="kpi-label">Pending Reviews</span>
            <span
              className="kpi-value"
              style={{
                color:
                  metrics.pendingReviewsCount > 0
                    ? 'var(--status-warn)'
                    : 'var(--text-main)',
              }}
            >
              {metrics.pendingReviewsCount}
            </span>
            <span className="kpi-hint">
              {metrics.pendingReviewsCount > 0
                ? 'Requires staff approval to publish'
                : 'All submitted reviews moderated'}
            </span>
          </div>

          {/* User Directory */}
          <div className="card kpi-card" id="kpi-users">
            <span className="kpi-label">Registered Accounts</span>
            <span className="kpi-value">{metrics.totalUsers}</span>
            <div className="row" style={{ gap: '0.4rem', marginTop: '0.2rem' }}>
              <span className="pill pill-ok">{metrics.activeUsers} Active</span>
              <span className="pill pill-staff">{metrics.staffUsers} Staff/Admin</span>
            </div>
          </div>
        </div>

        {/* Quick Operational Shortcuts */}
        <div>
          <h2>Operational Workspaces</h2>
          <div className="quick-actions-grid">
            <Link href="/orders" className="action-card" id="action-orders">
              {metrics.confirmedOrders > 0 && (
                <span className="badge-count" style={{ color: 'var(--status-warn)' }}>
                  {metrics.confirmedOrders} Pending
                </span>
              )}
              <div className="action-card-icon">📦</div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Fulfillment & Orders</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Inspect customer orders, trigger shipment dispatches, and issue refunds.
              </div>
            </Link>

            <Link href="/inventory" className="action-card" id="action-inventory">
              {(metrics.lowStockCount > 0 || metrics.outOfStockCount > 0) && (
                <span className="badge-count" style={{ color: 'var(--status-crit)' }}>
                  {metrics.lowStockCount + metrics.outOfStockCount} Alerts
                </span>
              )}
              <div className="action-card-icon">📊</div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Warehouse Inventory</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                View available quantities and execute manual stock adjustments.
              </div>
            </Link>

            <Link href="/reviews" className="action-card" id="action-reviews">
              {metrics.pendingReviewsCount > 0 && (
                <span className="badge-count" style={{ color: 'var(--status-warn)' }}>
                  {metrics.pendingReviewsCount} Pending
                </span>
              )}
              <div className="action-card-icon">⭐</div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Review Moderation</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Approve or reject customer reviews to update public rating rollups.
              </div>
            </Link>

            <Link href="/users" className="action-card" id="action-users">
              <div className="action-card-icon">👥</div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>User Directory & Roles</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Manage user lifecycle, promote/demote roles, and revoke active sessions.
              </div>
            </Link>

            <Link href="/catalog" className="action-card" id="action-catalog">
              <div className="action-card-icon">🏷️</div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Product Catalog</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Create and edit products, assign categories, and maintain price definitions.
              </div>
            </Link>

            {isAdmin && (
              <Link href="/system" className="action-card" id="action-system">
                <div className="action-card-icon">⚙️</div>
                <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>System Maintenance</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Re-sync OpenSearch catalog index and rebuild co-purchase models.
                </div>
              </Link>
            )}
          </div>
        </div>

        {/* Recent Orders Stream */}
        <RecentOrdersTable orders={recentOrders} loading={loading} />

        {/* Live Microservice Mesh Health Matrix */}
        <HealthMatrix />
      </div>
    </AuthGate>
  );
}
