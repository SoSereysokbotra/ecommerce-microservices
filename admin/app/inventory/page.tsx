'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '@/components/AuthGate';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/formatters';

interface StockItem {
  productId: string;
  availableQty: number;
  reservedQty: number;
  version: number;
  updatedAt: string;
}

interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  slug: string;
  active: boolean;
  priceMinor: number;
  currency: string;
}

interface PaginatedProductsResponse {
  data: ProductSummary[];
  nextCursor?: string | null;
}

interface InventoryRow {
  productId: string;
  sku: string;
  name: string;
  slug: string;
  availableQty: number;
  reservedQty: number;
  totalStock: number;
  updatedAt?: string;
  inCatalog: boolean;
}

type StockFilter = 'all' | 'out_of_stock' | 'low_stock' | 'in_stock';

export default function InventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'crit'; text: string } | null>(null);

  // Filters & Search
  const [search, setSearch] = useState<string>('');
  const [filter, setFilter] = useState<StockFilter>('all');

  // Adjust Modal State
  const [adjustingItem, setAdjustingItem] = useState<InventoryRow | null>(null);
  const [adjustDelta, setAdjustDelta] = useState<string>('10');
  const [adjustReason, setAdjustReason] = useState<string>('Warehouse replenishment');
  const [adjustSaving, setAdjustSaving] = useState<boolean>(false);

  // Set Modal State
  const [settingItem, setSettingItem] = useState<InventoryRow | null>(null);
  const [setNewQty, setSetNewQty] = useState<string>('0');
  const [setSaving, setSetSaving] = useState<boolean>(false);

  const fetchInventoryData = async () => {
    setLoading(true);
    try {
      const [stockList, productsRes] = await Promise.all([
        api.get<StockItem[]>('/inventory/stock'),
        api
          .get<PaginatedProductsResponse>('/catalog/products?limit=100&active=true')
          .catch(() => ({ data: [] })),
      ]);

      const productMap = new Map<string, ProductSummary>();
      for (const prod of productsRes.data || []) {
        productMap.set(prod.id, prod);
      }

      // Build unified rows from stock
      const combinedRows: InventoryRow[] = (stockList || []).map((s) => {
        const prod = productMap.get(s.productId);
        return {
          productId: s.productId,
          sku: prod ? prod.sku : s.productId.slice(0, 8),
          name: prod ? prod.name : 'Unknown Product',
          slug: prod ? prod.slug : '',
          availableQty: s.availableQty,
          reservedQty: s.reservedQty,
          totalStock: s.availableQty + s.reservedQty,
          updatedAt: s.updatedAt,
          inCatalog: Boolean(prod),
        };
      });

      // Also include any catalog products that don't have stock records yet
      const seenProductIds = new Set(combinedRows.map((r) => r.productId));
      for (const prod of productsRes.data || []) {
        if (!seenProductIds.has(prod.id)) {
          combinedRows.push({
            productId: prod.id,
            sku: prod.sku,
            name: prod.name,
            slug: prod.slug,
            availableQty: 0,
            reservedQty: 0,
            totalStock: 0,
            inCatalog: true,
          });
        }
      }

      // Sort by availableQty ascending so low stock items are on top
      combinedRows.sort((a, b) => a.availableQty - b.availableQty);
      setRows(combinedRows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch inventory stock';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api.get<StockItem[]>('/inventory/stock'),
      api
        .get<PaginatedProductsResponse>('/catalog/products?limit=100&active=true')
        .catch(() => ({ data: [] })),
    ])
      .then(([stockList, productsRes]) => {
        if (!mounted) return;
        const productMap = new Map<string, ProductSummary>();
        for (const prod of productsRes.data || []) {
          productMap.set(prod.id, prod);
        }

        const combinedRows: InventoryRow[] = (stockList || []).map((s) => {
          const prod = productMap.get(s.productId);
          return {
            productId: s.productId,
            sku: prod ? prod.sku : s.productId.slice(0, 8),
            name: prod ? prod.name : 'Unknown Product',
            slug: prod ? prod.slug : '',
            availableQty: s.availableQty,
            reservedQty: s.reservedQty,
            totalStock: s.availableQty + s.reservedQty,
            updatedAt: s.updatedAt,
            inCatalog: Boolean(prod),
          };
        });

        const seenProductIds = new Set(combinedRows.map((r) => r.productId));
        for (const prod of productsRes.data || []) {
          if (!seenProductIds.has(prod.id)) {
            combinedRows.push({
              productId: prod.id,
              sku: prod.sku,
              name: prod.name,
              slug: prod.slug,
              availableQty: 0,
              reservedQty: 0,
              totalStock: 0,
              inCatalog: true,
            });
          }
        }

        combinedRows.sort((a, b) => a.availableQty - b.availableQty);
        setRows(combinedRows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to fetch inventory stock';
        setFeedback({ type: 'crit', text: msg });
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Compute KPI metrics
  const totalSkus = rows.length;
  const totalAvailable = rows.reduce((acc, r) => acc + r.availableQty, 0);
  const totalReserved = rows.reduce((acc, r) => acc + r.reservedQty, 0);
  const outOfStockCount = rows.filter((r) => r.availableQty <= 0).length;
  const lowStockCount = rows.filter((r) => r.availableQty > 0 && r.availableQty <= 10).length;

  // Filter & Search Logic
  const filteredRows = rows.filter((r) => {
    // Status filter
    if (filter === 'out_of_stock' && r.availableQty > 0) return false;
    if (filter === 'low_stock' && (r.availableQty <= 0 || r.availableQty > 10)) return false;
    if (filter === 'in_stock' && r.availableQty <= 10) return false;

    // Search query
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchName = r.name.toLowerCase().includes(q);
      const matchSku = r.sku.toLowerCase().includes(q);
      const matchId = r.productId.toLowerCase().includes(q);
      return matchName || matchSku || matchId;
    }

    return true;
  });

  const openAdjustModal = (item: InventoryRow, defaultDelta: number = 10) => {
    setAdjustingItem(item);
    setAdjustDelta(String(defaultDelta));
    setAdjustReason('Warehouse replenishment');
    setAdjustSaving(false);
  };

  const openSetModal = (item: InventoryRow) => {
    setSettingItem(item);
    setSetNewQty(String(item.availableQty));
    setSetSaving(false);
  };

  const handleAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustingItem) return;

    const deltaNum = parseInt(adjustDelta, 10);
    if (isNaN(deltaNum) || deltaNum === 0) {
      setFeedback({ type: 'crit', text: 'Adjustment delta must be a non-zero integer.' });
      return;
    }

    if (!adjustReason.trim()) {
      setFeedback({ type: 'crit', text: 'Adjustment reason is required.' });
      return;
    }

    setAdjustSaving(true);
    setFeedback(null);

    try {
      const updatedStock = await api.post<StockItem>(
        `/inventory/stock/${adjustingItem.productId}/adjust`,
        {
          delta: deltaNum,
          reason: adjustReason.trim(),
        },
      );

      setRows((prev) =>
        prev.map((r) =>
          r.productId === adjustingItem.productId
            ? {
                ...r,
                availableQty: updatedStock.availableQty,
                reservedQty: updatedStock.reservedQty,
                totalStock: updatedStock.availableQty + updatedStock.reservedQty,
                updatedAt: updatedStock.updatedAt,
              }
            : r,
        ),
      );

      setFeedback({
        type: 'ok',
        text: `Stock for ${adjustingItem.name} (${adjustingItem.sku}) adjusted by ${deltaNum > 0 ? `+${deltaNum}` : deltaNum}. New available: ${updatedStock.availableQty} units.`,
      });
      setAdjustingItem(null);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to adjust stock.';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setAdjustSaving(false);
    }
  };

  const handleSetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingItem) return;

    const qtyNum = parseInt(setNewQty, 10);
    if (isNaN(qtyNum) || qtyNum < 0) {
      setFeedback({ type: 'crit', text: 'Stock quantity must be a non-negative integer (>= 0).' });
      return;
    }

    setSetSaving(true);
    setFeedback(null);

    try {
      const updatedStock = await api.put<StockItem>(`/inventory/stock/${settingItem.productId}`, {
        availableQty: qtyNum,
      });

      setRows((prev) =>
        prev.map((r) =>
          r.productId === settingItem.productId
            ? {
                ...r,
                availableQty: updatedStock.availableQty,
                reservedQty: updatedStock.reservedQty,
                totalStock: updatedStock.availableQty + updatedStock.reservedQty,
                updatedAt: updatedStock.updatedAt,
              }
            : r,
        ),
      );

      setFeedback({
        type: 'ok',
        text: `Stock for ${settingItem.name} (${settingItem.sku}) updated to ${qtyNum} available units.`,
      });
      setSettingItem(null);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to set stock quantity.';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setSetSaving(false);
    }
  };

  return (
    <AuthGate>
      <div className="content-container">
        {/* Top Header */}
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}
        >
          <div>
            <h1>Warehouse Stock & Inventory</h1>
            <p className="subtitle">
              Monitor real-time product stock, reserve allocations, and perform adjustments.
            </p>
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            <button
              id="btn-refresh-inventory"
              type="button"
              className="btn btn-secondary"
              onClick={fetchInventoryData}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : '↻ Refresh Stock'}
            </button>
            <Link href="/catalog" className="btn btn-secondary" id="btn-view-catalog">
              View Product Catalog
            </Link>
          </div>
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

        {/* Inventory KPI Grid */}
        <div className="grid-kpi">
          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Tracked SKUs
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800 }}>{totalSkus}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Products active in warehouse mesh
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Available for Purchase
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--accent-primary)' }}>
              {totalAvailable.toLocaleString()}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Unreserved sellable stock
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Reserved in Orders
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--badge-staff)' }}>
              {totalReserved.toLocaleString()}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Allocated to pending checkouts
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Stock Alerts
            </div>
            <div
              className="row"
              style={{ gap: '0.5rem', alignItems: 'center', marginTop: '0.2rem' }}
            >
              <span className="pill pill-crit" id="kpi-out-of-stock">
                {outOfStockCount} Out of Stock
              </span>
              <span className="pill pill-warn" id="kpi-low-stock">
                {lowStockCount} Low Stock
              </span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.4rem' }}>
              Priority items needing restocking
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
              id="stock-search"
              type="text"
              placeholder="Search by product name, SKU, or UUID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: '220px' }}
            />

            <select
              id="stock-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as StockFilter)}
              style={{ width: '180px' }}
            >
              <option value="all">All Items ({rows.length})</option>
              <option value="out_of_stock">Out of Stock ({outOfStockCount})</option>
              <option value="low_stock">Low Stock (≤10) ({lowStockCount})</option>
              <option value="in_stock">Healthy Stock (&gt;10)</option>
            </select>
          </div>

          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Showing <strong>{filteredRows.length}</strong> of {rows.length} inventory items
          </div>
        </div>

        {/* Inventory Stock Table */}
        <div className="table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product & SKU</th>
                <th>Stock Status</th>
                <th style={{ textAlign: 'right' }}>Available Units</th>
                <th style={{ textAlign: 'right' }}>Reserved</th>
                <th style={{ textAlign: 'right' }}>Total Inventory</th>
                <th>Last Updated</th>
                <th style={{ textAlign: 'center' }}>Stock Controls</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}
                  >
                    Loading real-time inventory levels…
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}
                  >
                    No inventory records match the current search & filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((item) => {
                  const isOutOfStock = item.availableQty <= 0;
                  const isLowStock = item.availableQty > 0 && item.availableQty <= 10;

                  return (
                    <tr key={item.productId} id={`row-stock-${item.productId}`}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>
                          {item.name}
                        </div>
                        <div className="row" style={{ gap: '0.5rem', marginTop: '0.15rem' }}>
                          <span
                            style={{
                              fontFamily: 'monospace',
                              fontSize: '0.78rem',
                              color: 'var(--accent-secondary)',
                            }}
                          >
                            {item.sku}
                          </span>
                          {!item.inCatalog && (
                            <span className="pill pill-customer" style={{ fontSize: '0.65rem' }}>
                              Not in active catalog
                            </span>
                          )}
                        </div>
                      </td>

                      <td>
                        {isOutOfStock ? (
                          <span className="pill pill-crit">Out of Stock</span>
                        ) : isLowStock ? (
                          <span className="pill pill-warn">Low Stock</span>
                        ) : (
                          <span className="pill pill-ok">In Stock</span>
                        )}
                      </td>

                      <td style={{ textAlign: 'right' }}>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '1rem',
                            color: isOutOfStock
                              ? 'var(--status-crit)'
                              : isLowStock
                                ? 'var(--status-warn)'
                                : 'var(--accent-primary)',
                          }}
                        >
                          {item.availableQty.toLocaleString()}
                        </span>
                      </td>

                      <td style={{ textAlign: 'right' }}>
                        <span
                          style={{
                            color:
                              item.reservedQty > 0 ? 'var(--badge-staff)' : 'var(--text-faint)',
                          }}
                        >
                          {item.reservedQty.toLocaleString()}
                        </span>
                      </td>

                      <td style={{ textAlign: 'right', fontWeight: 600 }}>
                        {item.totalStock.toLocaleString()}
                      </td>

                      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {item.updatedAt ? formatDate(item.updatedAt) : '—'}
                      </td>

                      <td style={{ textAlign: 'center' }}>
                        <div className="row" style={{ justifyContent: 'center', gap: '0.4rem' }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                            onClick={() => openAdjustModal(item, 10)}
                            title="Quick Restock +10"
                            id={`btn-quick-restock-${item.productId}`}
                          >
                            +10 Restock
                          </button>

                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                            onClick={() => openAdjustModal(item, 0)}
                            id={`btn-adjust-${item.productId}`}
                          >
                            Adjust Delta…
                          </button>

                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                            onClick={() => openSetModal(item)}
                            id={`btn-set-${item.productId}`}
                          >
                            Set Count…
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Adjust Delta Modal */}
        {adjustingItem && (
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
              justifyContent: 'center',
              zIndex: 100,
              backdropFilter: 'blur(4px)',
            }}
          >
            <div
              className="card"
              style={{
                width: '100%',
                maxWidth: '480px',
                padding: '1.75rem',
                backgroundColor: 'var(--bg-secondary)',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
              }}
            >
              <h2>Adjust Warehouse Stock</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Apply a signed quantity delta to <strong>{adjustingItem.name}</strong> (
                {adjustingItem.sku}).
              </p>

              <form onSubmit={handleAdjustSubmit} className="stack" style={{ gap: '1rem' }}>
                <div
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    padding: '0.85rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--line-subtle)',
                    fontSize: '0.85rem',
                  }}
                >
                  <div
                    className="row"
                    style={{ justifyContent: 'space-between', marginBottom: '0.25rem' }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>Current Available:</span>
                    <strong>{adjustingItem.availableQty} units</strong>
                  </div>
                  <div
                    className="row"
                    style={{ justifyContent: 'space-between', marginBottom: '0.25rem' }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>Adjustment Delta:</span>
                    <strong
                      style={{
                        color:
                          parseInt(adjustDelta || '0', 10) >= 0
                            ? 'var(--status-ok)'
                            : 'var(--status-crit)',
                      }}
                    >
                      {parseInt(adjustDelta || '0', 10) >= 0 ? `+${adjustDelta}` : adjustDelta}{' '}
                      units
                    </strong>
                  </div>
                  <div
                    className="row"
                    style={{
                      justifyContent: 'space-between',
                      borderTop: '1px solid var(--line-subtle)',
                      paddingTop: '0.35rem',
                      marginTop: '0.35rem',
                    }}
                  >
                    <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>
                      Projected Available:
                    </span>
                    <strong style={{ fontSize: '1rem', color: 'var(--accent-primary)' }}>
                      {Math.max(
                        0,
                        adjustingItem.availableQty + (parseInt(adjustDelta || '0', 10) || 0),
                      )}{' '}
                      units
                    </strong>
                  </div>
                </div>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Adjustment Delta (Positive to restock, negative to reduce)
                  </span>
                  <input
                    id="input-adjust-delta"
                    type="number"
                    value={adjustDelta}
                    onChange={(e) => setAdjustDelta(e.target.value)}
                    required
                  />
                </label>

                {/* Quick Delta Chips */}
                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span
                    style={{ fontSize: '0.75rem', color: 'var(--text-faint)', alignSelf: 'center' }}
                  >
                    Quick presets:
                  </span>
                  {['+5', '+10', '+25', '+50', '+100', '-1', '-5'].map((val) => (
                    <button
                      key={val}
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem' }}
                      onClick={() => setAdjustDelta(val.replace('+', ''))}
                    >
                      {val}
                    </button>
                  ))}
                </div>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Reason for Adjustment (Required by Audit Trail)
                  </span>
                  <input
                    id="input-adjust-reason"
                    type="text"
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    placeholder="e.g. Inbound shipment PO-8491, Damaged stock write-off"
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
                    onClick={() => setAdjustingItem(null)}
                    disabled={adjustSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={adjustSaving || !adjustDelta || parseInt(adjustDelta, 10) === 0}
                    id="btn-confirm-adjust"
                  >
                    {adjustSaving ? 'Applying Adjustment…' : 'Apply Adjustment'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Set Absolute Stock Modal */}
        {settingItem && (
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
              justifyContent: 'center',
              zIndex: 100,
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
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
              }}
            >
              <h2>Set Absolute Stock Level</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Directly override the warehouse quantity for <strong>{settingItem.name}</strong>.
              </p>

              <div
                style={{
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.75rem',
                  marginBottom: '1rem',
                  fontSize: '0.8rem',
                  color: 'var(--status-warn)',
                }}
              >
                ⚠️ <strong>Audit Warning:</strong> Setting the count directly overrides current
                available stock regardless of previous increments. Typically used following a manual
                physical inventory audit.
              </div>

              <form onSubmit={handleSetSubmit} className="stack" style={{ gap: '1rem' }}>
                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    New Available Quantity (must be ≥ 0)
                  </span>
                  <input
                    id="input-set-qty"
                    type="number"
                    min="0"
                    value={setNewQty}
                    onChange={(e) => setSetNewQty(e.target.value)}
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
                    onClick={() => setSettingItem(null)}
                    disabled={setSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={setSaving || !setNewQty || parseInt(setNewQty, 10) < 0}
                    id="btn-confirm-set"
                  >
                    {setSaving ? 'Saving…' : 'Confirm New Count'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AuthGate>
  );
}
