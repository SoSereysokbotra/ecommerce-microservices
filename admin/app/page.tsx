'use client';

import React from 'react';
import Link from 'next/link';
import { AuthGate } from '@/components/AuthGate';
import { useAuth } from '@/lib/auth-context';

export default function OverviewPage() {
  const { user, isAdmin } = useAuth();

  return (
    <AuthGate>
      <div className="stack" style={{ gap: '1.75rem' }}>
        {/* Welcome Banner */}
        <div
          className="card"
          style={{
            background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.95))',
            border: '1px solid var(--line-subtle)',
            padding: '1.75rem 2rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <div className="row" style={{ marginBottom: '0.4rem' }}>
              <h1 style={{ fontSize: '1.6rem' }}>Welcome, {user?.name || user?.email}</h1>
              <span
                className={`pill ${user?.role === 'ADMIN' ? 'pill-admin' : 'pill-staff'}`}
                style={{ fontSize: '0.75rem' }}
              >
                {user?.role} Session
              </span>
            </div>
            <p className="subtitle">
              Commerce Enterprise Operations & Administrative Console. All actions are scoped and audited.
            </p>
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            <span className="pill pill-ok">● Gateway Connected</span>
            <span className="pill pill-ok">● RBAC Matrix Enforced</span>
          </div>
        </div>

        {/* Phase 1 Verification Notice */}
        <div className="card">
          <h2>Phase 1: Architecture & Auth Gatekeeper Operational</h2>
          <p className="subtitle" style={{ marginBottom: '1rem' }}>
            The admin dashboard foundation has been initialized with Next.js 16, React 19, and the executive dark
            design system. Session tokens and cross-origin cookies are bound to the Gateway perimeter.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '1rem',
              marginTop: '1rem',
            }}
          >
            <div
              style={{
                padding: '1rem',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line-subtle)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--accent-primary)', marginBottom: '0.25rem' }}>
                ✓ Zero-Trust Perimeter
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Direct DB connections disabled. Only port 3000 API Gateway routes are reachable.
              </div>
            </div>

            <div
              style={{
                padding: '1rem',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line-subtle)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--accent-primary)', marginBottom: '0.25rem' }}>
                ✓ Strict Role Gatekeeping
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Authenticated as <strong style={{ color: 'var(--text-main)' }}>{user?.role}</strong>. Customers
                are rejected at login.
              </div>
            </div>

            <div
              style={{
                padding: '1rem',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line-subtle)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--accent-primary)', marginBottom: '0.25rem' }}>
                ✓ W3C Trace & Correlation
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Every request carries <code style={{ color: 'var(--accent-secondary)' }}>x-correlation-id</code> and{' '}
                <code style={{ color: 'var(--accent-secondary)' }}>traceparent</code> headers.
              </div>
            </div>
          </div>
        </div>

        {/* Operational Modules Quick Links */}
        <div>
          <h2>Operational Workspaces (Upcoming Phases)</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '1rem',
              marginTop: '0.75rem',
            }}
          >
            <Link href="/orders" className="card" style={{ cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>📦 Orders & Fulfillment</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Global multi-tenant orders feed, dispatching, and refunds.
              </div>
            </Link>

            <Link href="/catalog" className="card" style={{ cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>🏷️ Product Catalog</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Product authoring, categories, and price definitions.
              </div>
            </Link>

            <Link href="/inventory" className="card" style={{ cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>📊 Stock & Inventory</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Real-time warehouse inventory adjustments and restocking.
              </div>
            </Link>

            <Link href="/users" className="card" style={{ cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>👥 Users & Roles</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Directory, role escalation, account suspension, session kill.
              </div>
            </Link>

            <Link href="/reviews" className="card" style={{ cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>⭐ Review Moderation</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Pending queue, approval/rejection, verified purchaser checks.
              </div>
            </Link>

            <Link href="/coupons" className="card" style={{ cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>🎟️ Promotional Coupons</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Fixed/percent coupon codes, limits, and expiration dates.
              </div>
            </Link>

            {isAdmin && (
              <Link href="/system" className="card" style={{ cursor: 'pointer' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>⚙️ System Maintenance</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  OpenSearch index re-sync and recommendations rebuild.
                </div>
              </Link>
            )}
          </div>
        </div>
      </div>
    </AuthGate>
  );
}
