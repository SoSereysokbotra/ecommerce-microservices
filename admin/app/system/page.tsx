'use client';

import React, { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { api, ApiError } from '@/lib/api';
import { HealthMatrix } from '@/components/HealthMatrix';

interface LogEntry {
  timestamp: string;
  source: string;
  type: 'info' | 'success' | 'error';
  message: string;
}

export default function SystemPage() {
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      timestamp: new Date().toLocaleTimeString(),
      source: 'SYSTEM',
      type: 'info',
      message: 'Maintenance console initialized. Ready for operational replay triggers.',
    },
  ]);

  const [searchRunning, setSearchRunning] = useState<boolean>(false);
  const [recRunning, setRecRunning] = useState<boolean>(false);
  const [activeJob, setActiveJob] = useState<string | null>(null);

  const addLog = (source: string, type: 'info' | 'success' | 'error', message: string) => {
    setLogs((prev) => [
      ...prev,
      {
        timestamp: new Date().toLocaleTimeString(),
        source,
        type,
        message,
      },
    ]);
  };

  // Full 3-Step Search Reindex Pipeline
  const handleFullSearchReindex = async () => {
    setSearchRunning(true);
    setActiveJob('Full OpenSearch Reindex Pipeline');
    addLog('SEARCH', 'info', 'Step 1/3: Dropping and recreating OpenSearch index mappings…');

    try {
      // Step 1: Recreate Index
      const recreateRes = await api.post<{ index: string; next: string }>(
        '/search/admin/recreate-index',
        {},
      );
      addLog('SEARCH', 'success', `Step 1/3 Complete: Recreated index '${recreateRes.index}'.`);

      // Step 2: Republish Catalog Outbox
      addLog(
        'CATALOG',
        'info',
        'Step 2/3: Re-emitting catalog product and category updates into outbox…',
      );
      const catalogRes = await api.post<{ products: number; categories: number }>(
        '/catalog/admin/republish',
        {},
      );
      addLog(
        'CATALOG',
        'success',
        `Step 2/3 Complete: Queued ${catalogRes.products} products and ${catalogRes.categories} categories for indexing.`,
      );

      // Step 3: Republish Review Ratings
      addLog('REVIEWS', 'info', 'Step 3/3: Re-emitting rating rollups into outbox…');
      const reviewsRes = await api.post<{ ratings: number }>('/reviews/admin/republish', {});
      addLog(
        'REVIEWS',
        'success',
        `Step 3/3 Complete: Queued ${reviewsRes.ratings} product rating rollups.`,
      );

      addLog('SYSTEM', 'success', '✓ Full Search Index Re-synchronization completed successfully!');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Pipeline execution encountered an error';
      addLog('SEARCH', 'error', `Failed: ${msg}`);
    } finally {
      setSearchRunning(false);
      setActiveJob(null);
    }
  };

  // Step 1 Only: Recreate OpenSearch Index
  const handleRecreateIndexOnly = async () => {
    setSearchRunning(true);
    addLog('SEARCH', 'info', 'Invoking POST /search/admin/recreate-index…');
    try {
      const res = await api.post<{ index: string }>('/search/admin/recreate-index', {});
      addLog(
        'SEARCH',
        'success',
        `Index '${res.index}' successfully recreated empty with current mappings.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to recreate index';
      addLog('SEARCH', 'error', msg);
    } finally {
      setSearchRunning(false);
    }
  };

  // Step 2 Only: Republish Catalog
  const handleRepublishCatalogOnly = async () => {
    setSearchRunning(true);
    addLog('CATALOG', 'info', 'Invoking POST /catalog/admin/republish…');
    try {
      const res = await api.post<{ products: number; categories: number }>(
        '/catalog/admin/republish',
        {},
      );
      addLog(
        'CATALOG',
        'success',
        `Republished ${res.products} products and ${res.categories} categories to outbox.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to republish catalog';
      addLog('CATALOG', 'error', msg);
    } finally {
      setSearchRunning(false);
    }
  };

  // Full 2-Step Recommendations Graph Rebuild Pipeline
  const handleFullRecommendationsRebuild = async () => {
    setRecRunning(true);
    setActiveJob('Recommendations Graph Rebuild Pipeline');
    addLog(
      'RECOMMENDATIONS',
      'info',
      'Step 1/2: Truncating graph and resetting processed_events markers…',
    );

    try {
      // Step 1: Reset Recommendations
      await api.post('/recommendations/admin/reset', {});
      addLog('RECOMMENDATIONS', 'success', 'Step 1/2 Complete: Truncated recommendations graph.');

      // Step 2: Replay Confirmed Orders
      addLog('ORDERS', 'info', 'Step 2/2: Replaying co-purchase events for all confirmed orders…');
      const replayRes = await api.post<{ orders: number }>('/orders/admin/replay-co-purchases', {});
      addLog(
        'ORDERS',
        'success',
        `Step 2/2 Complete: Re-announced co-purchases across ${replayRes.orders} confirmed customer orders.`,
      );

      addLog('SYSTEM', 'success', '✓ Recommendation graph rebuilt with zero double-counting!');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Recommendation rebuild failed';
      addLog('RECOMMENDATIONS', 'error', `Failed: ${msg}`);
    } finally {
      setRecRunning(false);
      setActiveJob(null);
    }
  };

  // Reset Recommendations Only
  const handleResetRecsOnly = async () => {
    setRecRunning(true);
    addLog('RECOMMENDATIONS', 'info', 'Invoking POST /recommendations/admin/reset…');
    try {
      await api.post('/recommendations/admin/reset', {});
      addLog('RECOMMENDATIONS', 'success', 'Recommendations graph truncated and markers reset.');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Reset failed';
      addLog('RECOMMENDATIONS', 'error', msg);
    } finally {
      setRecRunning(false);
    }
  };

  // Replay Co-Purchases Only
  const handleReplayOrdersOnly = async () => {
    setRecRunning(true);
    addLog('ORDERS', 'info', 'Invoking POST /orders/admin/replay-co-purchases…');
    try {
      const res = await api.post<{ orders: number }>('/orders/admin/replay-co-purchases', {});
      addLog(
        'ORDERS',
        'success',
        `Replayed co-purchase events for ${res.orders} confirmed orders.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Order replay failed';
      addLog('ORDERS', 'error', msg);
    } finally {
      setRecRunning(false);
    }
  };

  return (
    <AuthGate requiredRole="ADMIN">
      <div className="content-container">
        {/* Header */}
        <div style={{ marginBottom: '2rem' }}>
          <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
            <h1>System Maintenance & Mesh Replays</h1>
            <span className="pill pill-admin">ADMIN ONLY</span>
          </div>
          <p className="subtitle">
            Synchronize distributed read models, trigger event outbox replays, and reset search
            indexing.
          </p>
        </div>

        {/* Current Job Banner (if active) */}
        {activeJob && (
          <div
            className="pill pill-warn"
            style={{
              padding: '0.75rem 1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              marginBottom: '1.5rem',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div
              style={{
                width: '14px',
                height: '14px',
                border: '2px solid currentColor',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
            <span>
              <strong>Running Job:</strong> {activeJob}…
            </span>
          </div>
        )}

        {/* Operational Cards Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
            gap: '1.5rem',
            marginBottom: '2rem',
          }}
        >
          {/* OpenSearch Maintenance */}
          <div
            className="card"
            style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
          >
            <div>
              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <h2 style={{ margin: 0 }}>OpenSearch Catalog Index</h2>
                <span className="pill pill-staff">SEARCH SERVICE</span>
              </div>
              <p className="subtitle" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
                OpenSearch projects data from two write-side outboxes (<strong>catalog</strong> for
                products/categories, and <strong>reviews</strong> for rating rollups). Rebuilding
                drops the index, recreates the mapping schema, and replays both outboxes.
              </p>

              <div
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  marginTop: '1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                <div>
                  1. <code>POST /search/admin/recreate-index</code>
                </div>
                <div>
                  2. <code>POST /catalog/admin/republish</code>
                </div>
                <div>
                  3. <code>POST /reviews/admin/republish</code>
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleFullSearchReindex}
                disabled={searchRunning || recRunning}
                id="btn-full-search-reindex"
              >
                {searchRunning ? 'Reindexing OpenSearch…' : '⚡ Execute Full Search Re-Sync'}
              </button>

              <div className="row" style={{ gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={handleRecreateIndexOnly}
                  disabled={searchRunning || recRunning}
                >
                  Drop Index Only
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={handleRepublishCatalogOnly}
                  disabled={searchRunning || recRunning}
                >
                  Republish Catalog
                </button>
              </div>
            </div>
          </div>

          {/* Recommendations Graph Maintenance */}
          <div
            className="card"
            style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
          >
            <div>
              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <h2 style={{ margin: 0 }}>Co-Purchase Recommendation Graph</h2>
                <span className="pill pill-staff">RECOMMENDATIONS</span>
              </div>
              <p className="subtitle" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
                Collaborative filtering builds frequent co-purchase product pairs from confirmed
                orders. To prevent count-doubling, the read table and idempotency markers must be
                reset before orders-service replays.
              </p>

              <div
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  marginTop: '1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                <div>
                  1. <code>POST /recommendations/admin/reset</code> (Truncate Graph)
                </div>
                <div>
                  2. <code>POST /orders/admin/replay-co-purchases</code> (Replay Pairs)
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleFullRecommendationsRebuild}
                disabled={searchRunning || recRunning}
                id="btn-full-recommendations-rebuild"
              >
                {recRunning ? 'Rebuilding Graph…' : '⚡ Rebuild Recommendation Model'}
              </button>

              <div className="row" style={{ gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={handleResetRecsOnly}
                  disabled={searchRunning || recRunning}
                >
                  Truncate Graph Only
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={handleReplayOrdersOnly}
                  disabled={searchRunning || recRunning}
                >
                  Replay Orders Only
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Live Terminal Output */}
        <div
          className="card"
          style={{
            backgroundColor: '#050c14',
            border: '1px solid var(--line-subtle)',
            marginBottom: '2.5rem',
          }}
        >
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--status-ok)',
                }}
              />
              <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.85rem' }}>
                Operational Output Console
              </span>
            </div>

            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
              onClick={() => setLogs([])}
            >
              Clear Console
            </button>
          </div>

          <div
            style={{
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              maxHeight: '260px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              padding: '0.5rem 0',
            }}
          >
            {logs.length === 0 ? (
              <span style={{ color: 'var(--text-faint)' }}>Console is empty.</span>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="row" style={{ gap: '0.75rem', alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--text-faint)' }}>[{log.timestamp}]</span>
                  <span
                    style={{
                      fontWeight: 700,
                      color:
                        log.source === 'SYSTEM'
                          ? 'var(--accent-secondary)'
                          : log.source === 'SEARCH'
                            ? 'var(--badge-admin)'
                            : 'var(--badge-staff)',
                    }}
                  >
                    [{log.source}]
                  </span>
                  <span
                    style={{
                      color:
                        log.type === 'success'
                          ? 'var(--status-ok)'
                          : log.type === 'error'
                            ? 'var(--status-crit)'
                            : 'var(--text-main)',
                    }}
                  >
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Real-Time Microservice Mesh Status */}
        <HealthMatrix />
      </div>
    </AuthGate>
  );
}
