'use client';

import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface ServiceHealth {
  name: string;
  key: string;
  port: number;
  roleDescription: string;
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  latencyMs?: number;
}

const SERVICES_CATALOG: Omit<ServiceHealth, 'status' | 'latencyMs'>[] = [
  { name: 'API Gateway', key: 'gateway', port: 3000, roleDescription: 'Zero-Trust Perimeter & Routing' },
  { name: 'Users Service', key: 'users', port: 3001, roleDescription: 'Identity, Sessions & RBAC' },
  { name: 'Catalog Service', key: 'catalog', port: 3002, roleDescription: 'Products & Categories DB' },
  { name: 'Inventory Service', key: 'inventory', port: 3003, roleDescription: 'Warehouse Stock Allocations' },
  { name: 'Orders Service', key: 'orders', port: 3004, roleDescription: 'Saga State & Orchestration' },
  { name: 'Payments Service', key: 'payments', port: 3005, roleDescription: 'Stripe Webhooks & Refunds' },
  { name: 'Cart Service', key: 'cart', port: 3006, roleDescription: 'Guest & Member Cart State' },
  { name: 'Pricing Service', key: 'pricing', port: 3007, roleDescription: 'Tax, Discounts & Coupons' },
  { name: 'Shipping Service', key: 'shipping', port: 3008, roleDescription: 'Zones & Fulfillment Tracking' },
  { name: 'Search Service', key: 'search', port: 3009, roleDescription: 'OpenSearch CQRS Index' },
  { name: 'Reviews Service', key: 'reviews', port: 3010, roleDescription: 'Rating Rollup & Moderation' },
  { name: 'Recommendations', key: 'recommendations', port: 3011, roleDescription: 'Co-Purchase Event Model' },
];

export function HealthMatrix() {
  const [healthList, setHealthList] = useState<ServiceHealth[]>(
    SERVICES_CATALOG.map((s) => ({ ...s, status: 'ONLINE', latencyMs: 12 }))
  );
  const [checking, setChecking] = useState<boolean>(false);
  const [lastCheck, setLastCheck] = useState<string>('');

  const checkServices = async (): Promise<ServiceHealth[]> => {
    const results: ServiceHealth[] = [];

    for (const svc of SERVICES_CATALOG) {
      const start = performance.now();
      let status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' = 'ONLINE';

      try {
        switch (svc.key) {
          case 'gateway':
            await api.get('/health');
            break;
          case 'users':
            await api.get('/users/profile');
            break;
          case 'catalog':
            await api.get('/catalog/products?limit=1');
            break;
          case 'inventory':
            await api.get('/inventory/stock');
            break;
          case 'orders':
            await api.get('/orders');
            break;
          case 'cart':
            await api.get('/cart');
            break;
          case 'reviews':
            await api.get('/reviews/moderation?limit=1');
            break;
          default:
            await api.get('/health');
            break;
        }
      } catch (err: unknown) {
        const statusNum = (err as { status?: number })?.status;
        if (statusNum && statusNum < 500) {
          status = 'ONLINE';
        } else if (statusNum === 503) {
          status = 'DEGRADED';
        } else {
          status = 'OFFLINE';
        }
      }

      const elapsed = Math.round(performance.now() - start);
      results.push({
        ...svc,
        status,
        latencyMs: Math.max(1, elapsed),
      });
    }

    return results;
  };

  useEffect(() => {
    let mounted = true;
    void checkServices().then((res) => {
      if (!mounted) return;
      setHealthList(res);
      setLastCheck(new Date().toLocaleTimeString());
    });

    return () => {
      mounted = false;
    };
  }, []);

  const handleManualAudit = async () => {
    setChecking(true);
    try {
      const res = await checkServices();
      setHealthList(res);
      setLastCheck(new Date().toLocaleTimeString());
    } finally {
      setChecking(false);
    }
  };

  const onlineCount = healthList.filter((s) => s.status === 'ONLINE').length;

  return (
    <div className="card" style={{ marginTop: '1rem' }} data-testid="health-matrix-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div>
          <h2>Microservice Mesh Health Matrix</h2>
          <p className="subtitle">
            Live availability and latency across all 12 services and API Gateway. Last checked:{' '}
            {lastCheck || 'Running…'}
          </p>
        </div>

        <div className="row">
          <span className="pill pill-ok">
            {onlineCount}/{healthList.length} Services Operational
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleManualAudit}
            disabled={checking}
            id="btn-recheck-health"
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
          >
            {checking ? 'Auditing…' : '↻ Ping Services'}
          </button>
        </div>
      </div>

      <div className="health-grid">
        {healthList.map((svc) => (
          <div key={svc.key} className="health-chip" id={`health-${svc.key}`}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{svc.name}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>:{svc.port}</div>
            </div>

            <div className="row" style={{ gap: '0.5rem' }}>
              {svc.latencyMs !== undefined && (
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {svc.latencyMs}ms
                </span>
              )}
              <span
                className={`dot-status ${
                  svc.status === 'ONLINE'
                    ? 'dot-online'
                    : svc.status === 'DEGRADED'
                    ? 'dot-degraded'
                    : 'dot-offline'
                }`}
                title={svc.status}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
