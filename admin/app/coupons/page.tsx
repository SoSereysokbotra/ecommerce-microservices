'use client';

import React, { useEffect, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { useAuth } from '@/lib/auth-context';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/formatters';

interface DiscountRule {
  id: string;
  name: string;
  type: 'percentage' | 'fixed';
  valueBp: number | null;
  valueMinor: number | null;
}

interface CouponRecord {
  id: string;
  code: string;
  discountId: string;
  discount?: DiscountRule;
  maxUses: number | null;
  usedCount: number;
  perCustomerLimit: number | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export default function CouponsPage() {
  const { isAdmin } = useAuth();

  const [coupons, setCoupons] = useState<CouponRecord[]>([]);
  const [discounts, setDiscounts] = useState<DiscountRule[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'crit'; text: string } | null>(null);

  // Filters & Search
  const [search, setSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'exhausted' | 'inactive'>(
    'all',
  );

  // Create Modal State
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [formCode, setFormCode] = useState<string>('');
  const [formDiscountId, setFormDiscountId] = useState<string>('');
  const [formMaxUses, setFormMaxUses] = useState<string>('100');
  const [formPerCustomerLimit, setFormPerCustomerLimit] = useState<string>('1');
  const [formStartsAt, setFormStartsAt] = useState<string>('');
  const [formEndsAt, setFormEndsAt] = useState<string>('');
  const [formActive, setFormActive] = useState<boolean>(true);
  const [creating, setCreating] = useState<boolean>(false);

  // Delete State
  const [couponToDelete, setCouponToDelete] = useState<CouponRecord | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Tester State
  const [testCodeInput, setTestCodeInput] = useState<string>('');
  const [testResult, setTestResult] = useState<{
    valid: boolean;
    message?: string;
    discountName?: string;
  } | null>(null);
  const [testing, setTesting] = useState<boolean>(false);

  const fetchCouponsAndDiscounts = async () => {
    setLoading(true);
    try {
      const [couponsData, discountsData] = await Promise.all([
        api.get<CouponRecord[]>('/pricing/coupons').catch(() => []),
        api.get<DiscountRule[]>('/pricing/discounts').catch(() => []),
      ]);

      setCoupons(couponsData || []);
      setDiscounts(discountsData || []);
      if (discountsData && discountsData.length > 0 && !formDiscountId) {
        setFormDiscountId(discountsData[0].id);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch coupon data';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api.get<CouponRecord[]>('/pricing/coupons').catch(() => []),
      api.get<DiscountRule[]>('/pricing/discounts').catch(() => []),
    ])
      .then(([couponsData, discountsData]) => {
        if (!mounted) return;
        setCoupons(couponsData || []);
        setDiscounts(discountsData || []);
        if (discountsData && discountsData.length > 0) {
          setFormDiscountId(discountsData[0].id);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to fetch coupon data';
        setFeedback({ type: 'crit', text: msg });
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleGenerateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let rand = '';
    for (let i = 0; i < 8; i++) {
      rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setFormCode(`SAVE-${rand}`);
  };

  const handleCreateCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCode.trim() || !formDiscountId) {
      setFeedback({ type: 'crit', text: 'Coupon code and target discount rule are required.' });
      return;
    }

    setCreating(true);
    setFeedback(null);

    try {
      const payload: Record<string, unknown> = {
        code: formCode.trim().toUpperCase(),
        discountId: formDiscountId,
        active: formActive,
      };

      if (formMaxUses) {
        payload.maxUses = parseInt(formMaxUses, 10);
      }
      if (formPerCustomerLimit) {
        payload.perCustomerLimit = parseInt(formPerCustomerLimit, 10);
      }
      if (formStartsAt) {
        payload.startsAt = new Date(formStartsAt).toISOString();
      }
      if (formEndsAt) {
        payload.endsAt = new Date(formEndsAt).toISOString();
      }

      const created = await api.post<CouponRecord>('/pricing/coupons', payload);
      const discountObj = discounts.find((d) => d.id === formDiscountId);

      setCoupons((prev) => [{ ...created, discount: discountObj }, ...prev]);
      setFeedback({
        type: 'ok',
        text: `Coupon code '${created.code}' created successfully!`,
      });
      setIsCreateOpen(false);
      setFormCode('');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to create coupon code';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteCoupon = async () => {
    if (!couponToDelete) return;

    setDeleting(true);
    setFeedback(null);
    try {
      await api.delete(`/pricing/coupons/${couponToDelete.code}`);
      setCoupons((prev) => prev.filter((c) => c.code !== couponToDelete.code));
      setFeedback({
        type: 'ok',
        text: `Coupon code '${couponToDelete.code}' permanently deleted.`,
      });
      setCouponToDelete(null);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to delete coupon code';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setDeleting(false);
    }
  };

  const handleTestValidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testCodeInput.trim()) return;

    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.get<{ valid: boolean; message?: string; discountName?: string }>(
        `/pricing/coupons/${testCodeInput.trim().toUpperCase()}`,
      );
      setTestResult(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Validation failed';
      setTestResult({ valid: false, message: msg });
    } finally {
      setTesting(false);
    }
  };

  // Filtered List
  const filteredCoupons = coupons.filter((c) => {
    // Status filter
    if (statusFilter === 'active' && !c.active) return false;
    if (statusFilter === 'inactive' && c.active) return false;
    if (statusFilter === 'exhausted' && (c.maxUses === null || c.usedCount < c.maxUses))
      return false;

    // Search query
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchCode = c.code.toLowerCase().includes(q);
      const matchDiscount = c.discount?.name.toLowerCase().includes(q) ?? false;
      return matchCode || matchDiscount;
    }

    return true;
  });

  // KPI Calculations
  const totalCount = coupons.length;
  const activeCount = coupons.filter((c) => c.active).length;
  const totalClaims = coupons.reduce((sum, c) => sum + (c.usedCount || 0), 0);
  const exhaustedCount = coupons.filter(
    (c) => c.maxUses !== null && c.usedCount >= c.maxUses,
  ).length;

  return (
    <AuthGate>
      <div className="content-container">
        {/* Top Header */}
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}
        >
          <div>
            <h1>Promotions & Coupons Engine</h1>
            <p className="subtitle">
              Configure promotional campaign codes, allocate per-customer caps, and monitor claim
              volume.
            </p>
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            <button
              id="btn-refresh-coupons"
              type="button"
              className="btn btn-secondary"
              onClick={fetchCouponsAndDiscounts}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : '↻ Refresh'}
            </button>
            {isAdmin && (
              <button
                id="btn-create-coupon"
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  handleGenerateCode();
                  setIsCreateOpen(true);
                }}
              >
                + Create Coupon Code
              </button>
            )}
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

        {/* KPI Grid */}
        <div className="grid-kpi">
          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Configured Coupons
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800 }}>{totalCount}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Marketing campaign codes
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Active Codes
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--status-ok)' }}>
              {activeCount}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Ready for customer redemption
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Total Claims Logged
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--accent-primary)' }}>
              {totalClaims.toLocaleString()}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Uses claimed during checkouts
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Exhausted Limits
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--status-warn)' }}>
              {exhaustedCount}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
              Reached max allowable usages
            </div>
          </div>
        </div>

        {/* Interactive Storefront Code Validator Tool */}
        <div
          className="card"
          style={{ marginBottom: '1.5rem', backgroundColor: 'var(--bg-surface)' }}
        >
          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.5rem' }}>
            Storefront Code Simulation & Inspector
          </div>
          <p className="subtitle" style={{ fontSize: '0.8rem', marginBottom: '0.75rem' }}>
            Test how the pricing-service validation engine evaluates any code as typed by shoppers
            at checkout.
          </p>

          <form
            onSubmit={handleTestValidate}
            className="row"
            style={{ gap: '0.75rem', alignItems: 'center' }}
          >
            <input
              id="input-test-code"
              type="text"
              placeholder="e.g. SAVE20, WELCOME10"
              value={testCodeInput}
              onChange={(e) => setTestCodeInput(e.target.value)}
              style={{ width: '220px', textTransform: 'uppercase', fontFamily: 'monospace' }}
            />
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={testing || !testCodeInput.trim()}
              id="btn-simulate-code"
            >
              {testing ? 'Checking…' : 'Simulate Code Validation'}
            </button>

            {testResult && (
              <div
                className={`pill ${testResult.valid ? 'pill-ok' : 'pill-crit'}`}
                style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
              >
                {testResult.valid
                  ? `✓ Valid Code: Grants "${testResult.discountName || 'Discount'}"`
                  : `✕ Refused: ${testResult.message || 'Invalid code'}`}
              </div>
            )}
          </form>
        </div>

        {/* Search & Filter Bar */}
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
              id="coupons-search"
              type="text"
              placeholder="Search by code or discount name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: '220px' }}
            />

            <select
              id="coupons-filter"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | 'active' | 'exhausted' | 'inactive')
              }
              style={{ width: '180px' }}
            >
              <option value="all">All Coupons ({coupons.length})</option>
              <option value="active">Active Only ({activeCount})</option>
              <option value="exhausted">Exhausted Caps ({exhaustedCount})</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Showing <strong>{filteredCoupons.length}</strong> of {coupons.length} coupons
          </div>
        </div>

        {/* Coupons Table */}
        <div className="table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Coupon Code</th>
                <th>Discount Rule</th>
                <th>Usage / Cap</th>
                <th>Per-Customer Cap</th>
                <th>Active Window</th>
                <th>Status</th>
                {isAdmin && <th style={{ textAlign: 'center' }}>Admin Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading && coupons.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}
                  >
                    Loading coupon definitions…
                  </td>
                </tr>
              ) : filteredCoupons.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}
                  >
                    No coupons match the current criteria.
                  </td>
                </tr>
              ) : (
                filteredCoupons.map((coupon) => {
                  const isExhausted = coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses;
                  const discountDisplay = coupon.discount
                    ? coupon.discount.type === 'percentage'
                      ? `${(coupon.discount.valueBp || 0) / 100}% off (${coupon.discount.name})`
                      : `$${((coupon.discount.valueMinor || 0) / 100).toFixed(2)} off (${coupon.discount.name})`
                    : 'Active Rule';

                  return (
                    <tr key={coupon.id} id={`row-coupon-${coupon.code}`}>
                      <td>
                        <code
                          style={{
                            fontWeight: 700,
                            fontSize: '0.95rem',
                            color: 'var(--accent-primary)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {coupon.code}
                        </code>
                      </td>

                      <td>
                        <div style={{ fontWeight: 600 }}>{discountDisplay}</div>
                        <div
                          style={{
                            fontSize: '0.72rem',
                            color: 'var(--text-faint)',
                            fontFamily: 'monospace',
                          }}
                        >
                          Rule ID: {coupon.discountId.slice(0, 8)}…
                        </div>
                      </td>

                      <td>
                        <span style={{ fontWeight: 600 }}>{coupon.usedCount}</span>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {' '}
                          / {coupon.maxUses !== null ? coupon.maxUses : '∞ unlimited'}
                        </span>
                        {isExhausted && (
                          <span
                            className="pill pill-crit"
                            style={{ marginLeft: '0.4rem', fontSize: '0.65rem' }}
                          >
                            Exhausted
                          </span>
                        )}
                      </td>

                      <td>
                        {coupon.perCustomerLimit !== null ? (
                          <span>{coupon.perCustomerLimit} claim(s) / user</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>No limit</span>
                        )}
                      </td>

                      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {coupon.startsAt || coupon.endsAt ? (
                          <div>
                            <div>Start: {formatDate(coupon.startsAt)}</div>
                            <div>End: {formatDate(coupon.endsAt)}</div>
                          </div>
                        ) : (
                          'Always active'
                        )}
                      </td>

                      <td>
                        <span className={`pill ${coupon.active ? 'pill-ok' : 'pill-crit'}`}>
                          {coupon.active ? 'Active' : 'Disabled'}
                        </span>
                      </td>

                      {isAdmin && (
                        <td style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            className="btn btn-danger"
                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                            onClick={() => setCouponToDelete(coupon)}
                            id={`btn-delete-${coupon.code}`}
                          >
                            Delete…
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Create Coupon Modal */}
        {isCreateOpen && (
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
                maxWidth: '520px',
                padding: '1.75rem',
                backgroundColor: 'var(--bg-secondary)',
                maxHeight: '90vh',
                overflowY: 'auto',
              }}
            >
              <h2>Create Promotional Coupon</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Issue a code backed by an active pricing-service discount rule.
              </p>

              <form onSubmit={handleCreateCoupon} className="stack" style={{ gap: '1rem' }}>
                <label className="stack" style={{ gap: '0.3rem' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Coupon Code
                    </span>
                    <button
                      type="button"
                      onClick={handleGenerateCode}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--accent-primary)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      🎲 Generate Random
                    </button>
                  </div>
                  <input
                    id="input-coupon-code"
                    type="text"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    placeholder="e.g. FLASH25, SUMMER10"
                    maxLength={64}
                    style={{ textTransform: 'uppercase', fontFamily: 'monospace' }}
                    required
                  />
                </label>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Discount Promotion Rule
                  </span>
                  <select
                    id="select-discount-rule"
                    value={formDiscountId}
                    onChange={(e) => setFormDiscountId(e.target.value)}
                    required
                  >
                    {discounts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} (
                        {d.type === 'percentage'
                          ? `${(d.valueBp || 0) / 100}% off`
                          : `$${((d.valueMinor || 0) / 100).toFixed(2)} off`}
                        )
                      </option>
                    ))}
                  </select>
                </label>

                <div className="row" style={{ gap: '1rem' }}>
                  <label className="stack" style={{ gap: '0.3rem', flex: 1 }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Total Usages Cap (Leave blank for unlimited)
                    </span>
                    <input
                      id="input-max-uses"
                      type="number"
                      min="1"
                      value={formMaxUses}
                      onChange={(e) => setFormMaxUses(e.target.value)}
                      placeholder="e.g. 50"
                    />
                  </label>

                  <label className="stack" style={{ gap: '0.3rem', flex: 1 }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Per-Customer Cap
                    </span>
                    <input
                      id="input-customer-limit"
                      type="number"
                      min="1"
                      value={formPerCustomerLimit}
                      onChange={(e) => setFormPerCustomerLimit(e.target.value)}
                      placeholder="e.g. 1"
                    />
                  </label>
                </div>

                <div className="row" style={{ gap: '1rem' }}>
                  <label className="stack" style={{ gap: '0.3rem', flex: 1 }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Starts At (Optional)
                    </span>
                    <input
                      id="input-starts-at"
                      type="datetime-local"
                      value={formStartsAt}
                      onChange={(e) => setFormStartsAt(e.target.value)}
                    />
                  </label>

                  <label className="stack" style={{ gap: '0.3rem', flex: 1 }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Ends At (Optional)
                    </span>
                    <input
                      id="input-ends-at"
                      type="datetime-local"
                      value={formEndsAt}
                      onChange={(e) => setFormEndsAt(e.target.value)}
                    />
                  </label>
                </div>

                <label
                  className="row"
                  style={{ gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}
                >
                  <input
                    type="checkbox"
                    checked={formActive}
                    onChange={(e) => setFormActive(e.target.checked)}
                  />
                  <span style={{ fontSize: '0.85rem' }}>Active immediately upon creation</span>
                </label>

                <div
                  className="row"
                  style={{ justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setIsCreateOpen(false)}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={creating || !formCode.trim() || !formDiscountId}
                    id="btn-confirm-create-coupon"
                  >
                    {creating ? 'Creating Coupon…' : 'Create Coupon Code'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {couponToDelete && (
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
                maxWidth: '440px',
                padding: '1.75rem',
                backgroundColor: 'var(--bg-secondary)',
              }}
            >
              <h2>Delete Coupon Code</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Are you sure you want to permanently delete code{' '}
                <strong>{couponToDelete.code}</strong>? This action is irreversible and will reject
                any future checkout using this code.
              </p>

              <div className="row" style={{ justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCouponToDelete(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDeleteCoupon}
                  disabled={deleting}
                  id="btn-confirm-delete-coupon"
                >
                  {deleting ? 'Deleting…' : 'Delete Code'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGate>
  );
}
