'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout, isAdmin } = useAuth();

  // If on /login, don't show the sidebar shell
  if (pathname === '/login') {
    return <>{children}</>;
  }

  const navLinks = [
    { label: 'Overview', href: '/', id: 'nav-overview' },
    { label: 'Orders & Fulfillment', href: '/orders', id: 'nav-orders' },
    { label: 'Catalog Products', href: '/catalog', id: 'nav-catalog' },
    { label: 'Inventory & Stock', href: '/inventory', id: 'nav-inventory' },
    { label: 'User Directory & Roles', href: '/users', id: 'nav-users' },
    { label: 'Review Moderation', href: '/reviews', id: 'nav-reviews' },
    { label: 'Promotions & Coupons', href: '/coupons', id: 'nav-coupons' },
    { label: 'System Maintenance', href: '/system', id: 'nav-system', adminOnly: true },
  ];

  return (
    <div className="admin-shell">
      {/* Sidebar */}
      <aside className="admin-sidebar" data-testid="admin-sidebar">
        <div className="sidebar-header">
          <span className="brand-badge">OPS</span>
          <div>
            <div className="brand-title">Commerce Back-Office</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>Operations Console</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group-title">Navigation</div>
          {navLinks
            .filter((item) => !item.adminOnly || isAdmin)
            .map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  id={item.id}
                  className={`nav-item ${isActive ? 'active' : ''}`}
                >
                  <span>{item.label}</span>
                </Link>
              );
            })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile-pill" style={{ marginBottom: '0.75rem' }}>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user?.name ?? user?.email}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {user?.email}
              </div>
            </div>
            <span
              className={`pill ${user?.role === 'ADMIN' ? 'pill-admin' : 'pill-staff'}`}
              id="user-role-badge"
            >
              {user?.role}
            </span>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => logout()}
            style={{ width: '100%', fontSize: '0.8rem' }}
            id="btn-logout"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Pane */}
      <div className="admin-main">
        <header className="admin-topbar">
          <div className="topbar-title-section">
            <span
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 600,
              }}
            >
              Perimeter: Port 3000 Gateway
            </span>
          </div>

          <div className="topbar-actions">
            <span className="pill pill-ok" style={{ fontSize: '0.7rem' }}>
              ● Zero-Trust Active
            </span>
          </div>
        </header>

        <main className="content-container">{children}</main>
      </div>
    </div>
  );
}
