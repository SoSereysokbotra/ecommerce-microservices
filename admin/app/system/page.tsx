'use client';

import React, { useEffect, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { api, ApiError } from '@/lib/api';
import { HealthMatrix } from '@/components/HealthMatrix';

interface LogEntry {
  timestamp: string;
  source: string;
  type: 'info' | 'success' | 'error';
  message: string;
}

export interface CircuitBreakerSnapshot {
  serviceKey: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastError: string | null;
  recoveryTimeoutMs: number;
  failureThreshold: number;
}

export interface QueueStatus {
  queue: string;
  mainDepth: number;
  dlqQueue: string;
  dlqDepth: number;
  status: 'HEALTHY' | 'HAS_POISON_MSGS' | 'STANDBY';
}

export interface DlqStatsResponse {
  connected: boolean;
  totalQuarantined: number;
  queues: QueueStatus[];
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

  // Resilience & DLQ state (M18)
  const [circuits, setCircuits] = useState<CircuitBreakerSnapshot[]>([]);
  const [dlqStats, setDlqStats] = useState<DlqStatsResponse | null>(null);
  const [loadingResilience, setLoadingResilience] = useState<boolean>(false);
  const [replayingQueue, setReplayingQueue] = useState<string | null>(null);

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

  const fetchResilienceTelemetry = async () => {
    setLoadingResilience(true);
    try {
      const [circuitsRes, dlqRes] = await Promise.allSettled([
        api.get<CircuitBreakerSnapshot[]>('/admin/resilience/circuits'),
        api.get<DlqStatsResponse>('/admin/resilience/dlq'),
      ]);

      if (circuitsRes.status === 'fulfilled' && Array.isArray(circuitsRes.value)) {
        setCircuits(circuitsRes.value);
      }
      if (dlqRes.status === 'fulfilled' && dlqRes.value) {
        setDlqStats(dlqRes.value);
      }
    } catch {
      // Standby if endpoints not available
    } finally {
      setLoadingResilience(false);
    }
  };

  useEffect(() => {
    void fetchResilienceTelemetry();
    const timer = setInterval(() => {
      void fetchResilienceTelemetry();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // --- Search Reindex Pipeline --------------------------------------------

  const handleFullSearchReindex = async () => {
    setSearchRunning(true);
    setActiveJob('Full OpenSearch Reindex Pipeline');
    addLog('SEARCH', 'info', 'Step 1/3: Dropping and recreating OpenSearch index mappings…');

    try {
      const recreateRes = await api.post<{ index: string; next: string }>(
        '/search/admin/recreate-index',
        {},
      );
      addLog('SEARCH', 'success', `Step 1/3 Complete: Recreated index '${recreateRes.index}'.`);

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

  // --- Recommendations Graph Rebuild --------------------------------------

  const handleFullRecommendationsRebuild = async () => {
    setRecRunning(true);
    setActiveJob('Recommendations Graph Rebuild Pipeline');
    addLog(
      'RECOMMENDATIONS',
      'info',
      'Step 1/2: Truncating graph and resetting processed_events markers…',
    );

    try {
      await api.post('/recommendations/admin/reset', {});
      addLog('RECOMMENDATIONS', 'success', 'Step 1/2 Complete: Truncated recommendations graph.');

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

  // --- Circuit Breaker Actions (M18) --------------------------------------

  const handleResetCircuit = async (serviceKey: string) => {
    addLog('RESILIENCE', 'info', `Resetting circuit breaker for '${serviceKey}'…`);
    try {
      await api.post(`/admin/resilience/circuits/${serviceKey}/reset`, {});
      addLog('RESILIENCE', 'success', `Circuit breaker '${serviceKey}' reset to CLOSED.`);
      void fetchResilienceTelemetry();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to reset circuit breaker';
      addLog('RESILIENCE', 'error', msg);
    }
  };

  const handleResetAllCircuits = async () => {
    addLog('RESILIENCE', 'info', 'Resetting all gateway circuit breakers…');
    try {
      const res = await api.post<{ ok: boolean; resetCount: number }>(
        '/admin/resilience/circuits/reset-all',
        {},
      );
      addLog('RESILIENCE', 'success', `All ${res.resetCount} circuit breakers reset to CLOSED.`);
      void fetchResilienceTelemetry();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to reset all circuit breakers';
      addLog('RESILIENCE', 'error', msg);
    }
  };

  // --- RabbitMQ DLQ Actions (M18) -----------------------------------------

  const handleReplayDlq = async (queue: string) => {
    setReplayingQueue(queue);
    addLog('RABBITMQ', 'info', `Executing redrive from '${queue}.dlq' to event bus…`);
    try {
      const res = await api.post<{ ok: boolean; replayed: number; dlqQueue: string }>(
        `/admin/resilience/dlq/${queue}/replay`,
        { limit: 50 },
      );
      addLog(
        'RABBITMQ',
        'success',
        `✓ Redrive complete: Replayed ${res.replayed} messages from '${res.dlqQueue}' into commerce.events.`,
      );
      void fetchResilienceTelemetry();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'DLQ redrive failed';
      addLog('RABBITMQ', 'error', msg);
    } finally {
      setReplayingQueue(null);
    }
  };

  const handlePurgeDlq = async (queue: string) => {
    if (
      !confirm(
        `Are you sure you want to permanently purge all poison messages from '${queue}.dlq'?`,
      )
    ) {
      return;
    }
    addLog('RABBITMQ', 'info', `Purging dead letters from '${queue}.dlq'…`);
    try {
      const res = await api.post<{ ok: boolean; purged: number; dlqQueue: string }>(
        `/admin/resilience/dlq/${queue}/purge`,
        {},
      );
      addLog(
        'RABBITMQ',
        'success',
        `✓ Purged ${res.purged} quarantined messages from '${res.dlqQueue}'.`,
      );
      void fetchResilienceTelemetry();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'DLQ purge failed';
      addLog('RABBITMQ', 'error', msg);
    }
  };

  return (
    <AuthGate requiredRole="ADMIN">
      <div className="content-container">
        {/* Header */}
        <div style={{ marginBottom: '2rem' }}>
          <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
            <h1>System Maintenance & Resilience Console</h1>
            <span className="pill pill-admin">ADMIN ONLY</span>
          </div>
          <p className="subtitle">
            Manage circuit breakers, redrive Dead Letter Queues (DLQ), and synchronize distributed
            read models across the microservices mesh.
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

        {/* Section 1: CQRS Read Models & Outbox Replays */}
        <div style={{ marginBottom: '2.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
            🔄 Event Outbox Replays & CQRS Projections
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: '1.5rem',
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
                  <h3 style={{ margin: 0, fontSize: '1.1rem' }}>OpenSearch Catalog Index</h3>
                  <span className="pill pill-staff">SEARCH SERVICE</span>
                </div>
                <p className="subtitle" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
                  OpenSearch projects data from two write-side outboxes (<strong>catalog</strong>{' '}
                  for products/categories, and <strong>reviews</strong> for rating rollups).
                  Rebuilding drops the index, recreates the mapping schema, and replays both
                  outboxes.
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
                  <h3 style={{ margin: 0, fontSize: '1.1rem' }}>
                    Co-Purchase Recommendation Graph
                  </h3>
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
        </div>

        {/* Section 2: API Gateway Circuit Breakers (M18) */}
        <div style={{ marginBottom: '2.5rem' }}>
          <div
            className="row"
            style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}
          >
            <div>
              <h2 style={{ fontSize: '1.25rem', margin: 0 }}>⚡ API Gateway Circuit Breakers</h2>
              <p
                className="subtitle"
                style={{ fontSize: '0.85rem', margin: 0, marginTop: '0.25rem' }}
              >
                Per-service failure detection protecting gateway connections from downstream latency
                spikes.
              </p>
            </div>

            <div className="row" style={{ gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem' }}
                onClick={fetchResilienceTelemetry}
                disabled={loadingResilience}
              >
                🔄 Refresh Breakers
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem' }}
                onClick={handleResetAllCircuits}
              >
                Reset All Circuits
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '1rem',
            }}
          >
            {circuits.length === 0 ? (
              <div
                className="card"
                style={{
                  gridColumn: '1 / -1',
                  textAlign: 'center',
                  padding: '2rem',
                  color: 'var(--text-muted)',
                }}
              >
                {loadingResilience
                  ? 'Loading circuit breaker telemetry…'
                  : 'No circuit breaker metrics recorded yet (all upstreams healthy).'}
              </div>
            ) : (
              circuits.map((cb) => {
                const isOpen = cb.state === 'OPEN';
                const isHalfOpen = cb.state === 'HALF_OPEN';
                const isClosed = cb.state === 'CLOSED';

                return (
                  <div
                    key={cb.serviceKey}
                    className="card"
                    style={{
                      borderLeft: `4px solid ${
                        isOpen
                          ? 'var(--status-crit)'
                          : isHalfOpen
                            ? 'var(--status-warn)'
                            : 'var(--status-ok)'
                      }`,
                      padding: '1rem',
                    }}
                  >
                    <div
                      className="row"
                      style={{
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <strong style={{ fontSize: '0.9rem' }}>
                        {cb.serviceKey.replace('ServiceUrl', '')}
                      </strong>
                      <span
                        className={`pill ${
                          isOpen ? 'pill-crit' : isHalfOpen ? 'pill-warn' : 'pill-active'
                        }`}
                        style={{ fontSize: '0.7rem' }}
                      >
                        {cb.state}
                      </span>
                    </div>

                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.2rem',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <div>
                        Failures: <strong>{cb.consecutiveFailures}</strong> / {cb.failureThreshold}
                      </div>
                      {cb.lastError && (
                        <div
                          style={{
                            color: 'var(--status-crit)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={cb.lastError}
                        >
                          Error: {cb.lastError}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                      onClick={() => handleResetCircuit(cb.serviceKey)}
                      disabled={isClosed}
                    >
                      {isClosed ? 'Circuit Closed' : 'Reset to Closed'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Section 3: RabbitMQ Dead Letter Queue (DLQ) Monitor (M18) */}
        <div style={{ marginBottom: '2.5rem' }}>
          <div
            className="row"
            style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}
          >
            <div>
              <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
                <h2 style={{ fontSize: '1.25rem', margin: 0 }}>
                  🐰 RabbitMQ Dead-Letter Queues (DLQ)
                </h2>
                {dlqStats && (
                  <span
                    className={`pill ${
                      dlqStats.totalQuarantined > 0 ? 'pill-crit' : 'pill-active'
                    }`}
                  >
                    {dlqStats.totalQuarantined} Quarantined Messages
                  </span>
                )}
              </div>
              <p
                className="subtitle"
                style={{ fontSize: '0.85rem', margin: 0, marginTop: '0.25rem' }}
              >
                Poison messages isolated after 3 failed retries via <code>commerce.dlx</code>.
                Redrive quarantined messages back to the event bus once patched.
              </p>
            </div>

            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.75rem' }}
              onClick={fetchResilienceTelemetry}
              disabled={loadingResilience}
            >
              🔄 Refresh DLQ
            </button>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    borderBottom: '1px solid var(--line-subtle)',
                    textAlign: 'left',
                  }}
                >
                  <th style={{ padding: '0.75rem 1rem' }}>Queue Name</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Main Depth</th>
                  <th style={{ padding: '0.75rem 1rem' }}>DLQ Depth</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!dlqStats || dlqStats.queues.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        padding: '2rem',
                        textAlign: 'center',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {loadingResilience
                        ? 'Connecting to RabbitMQ management broker…'
                        : 'RabbitMQ DLQ telemetry unavailable.'}
                    </td>
                  </tr>
                ) : (
                  dlqStats.queues.map((q) => {
                    const hasPoison = q.dlqDepth > 0;
                    const isReplaying = replayingQueue === q.queue;

                    return (
                      <tr
                        key={q.queue}
                        style={{
                          borderBottom: '1px solid var(--line-subtle)',
                          backgroundColor: hasPoison ? 'rgba(239, 68, 68, 0.04)' : undefined,
                        }}
                      >
                        <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                          <code>{q.queue}</code>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: 'var(--text-muted)' }}>
                          {q.mainDepth} msgs
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <span
                            style={{
                              fontWeight: hasPoison ? 700 : 400,
                              color: hasPoison ? 'var(--status-crit)' : 'var(--text-muted)',
                            }}
                          >
                            {q.dlqDepth} msgs
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <span
                            className={`pill ${
                              hasPoison
                                ? 'pill-crit'
                                : q.status === 'STANDBY'
                                  ? 'pill-draft'
                                  : 'pill-active'
                            }`}
                            style={{ fontSize: '0.7rem' }}
                          >
                            {hasPoison
                              ? '⚠️ HAS POISON PILLS'
                              : q.status === 'STANDBY'
                                ? 'STANDBY'
                                : 'HEALTHY'}
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                          <div
                            className="row"
                            style={{ gap: '0.5rem', justifyContent: 'flex-end' }}
                          >
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
                              onClick={() => handleReplayDlq(q.queue)}
                              disabled={!hasPoison || isReplaying}
                            >
                              {isReplaying ? 'Redriving…' : '⚡ Redrive DLQ'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
                              onClick={() => handlePurgeDlq(q.queue)}
                              disabled={!hasPoison || isReplaying}
                            >
                              Purge
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
        </div>

        {/* Section 4: Observability & Distributed Tracing Telemetry (M19) */}
        <div style={{ marginBottom: '2.5rem' }}>
          <div
            className="row"
            style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}
          >
            <div>
              <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
                <h2 style={{ fontSize: '1.25rem', margin: 0 }}>
                  📊 Observability & Distributed Tracing Telemetry
                </h2>
                <span className="pill pill-active">LGTM STACK ACTIVE</span>
              </div>
              <p
                className="subtitle"
                style={{ fontSize: '0.85rem', margin: 0, marginTop: '0.25rem' }}
              >
                Full-spectrum distributed observability with W3C traceparent waterfalls (Tempo), RED
                metrics & Outbox lag (Prometheus), and correlated log pivots (Loki).
              </p>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '1rem',
            }}
          >
            {/* Grafana Dashboard Card */}
            <div
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <strong style={{ fontSize: '0.95rem' }}>📈 Grafana Commerce Mesh</strong>
                  <span className="pill pill-staff" style={{ fontSize: '0.7rem' }}>
                    PORT 3050
                  </span>
                </div>
                <p
                  className="subtitle"
                  style={{ fontSize: '0.8rem', lineHeight: 1.5, margin: 0, marginBottom: '0.75rem' }}
                >
                  Unified service mesh dashboard with real-time RED metrics (Rate, Errors,
                  Duration), Outbox lag gauges, and correlated log streams.
                </p>
              </div>
              <a
                href="http://localhost:3050/d/commerce-traces-logs/e-commerce-distributed-observability-mesh"
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
                style={{
                  textAlign: 'center',
                  textDecoration: 'none',
                  fontSize: '0.75rem',
                  padding: '0.4rem 0.75rem',
                }}
              >
                Launch Commerce Dashboard ↗
              </a>
            </div>

            {/* Tempo Distributed Tracing Card */}
            <div
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <strong style={{ fontSize: '0.95rem' }}>🕸️ Tempo Trace Waterfalls</strong>
                  <span className="pill pill-staff" style={{ fontSize: '0.7rem' }}>
                    PORT 3200 / 4318
                  </span>
                </div>
                <p
                  className="subtitle"
                  style={{ fontSize: '0.8rem', lineHeight: 1.5, margin: 0, marginBottom: '0.75rem' }}
                >
                  End-to-end W3C distributed trace waterfalls: Gateway HTTP (Server) ➔ Proxy
                  (Client) ➔ Orders Saga ➔ Outbox Relay (Producer) ➔ RabbitMQ (Consumer).
                </p>
              </div>
              <a
                href="http://localhost:3050/explore?left=%7B%22datasource%22:%22tempo%22%7D"
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{
                  textAlign: 'center',
                  textDecoration: 'none',
                  fontSize: '0.75rem',
                  padding: '0.4rem 0.75rem',
                }}
              >
                Explore Tempo Traces ↗
              </a>
            </div>

            {/* Prometheus Metrics Engine Card */}
            <div
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <strong style={{ fontSize: '0.95rem' }}>⏱️ Prometheus Metrics Engine</strong>
                  <span className="pill pill-staff" style={{ fontSize: '0.7rem' }}>
                    PORT 9090
                  </span>
                </div>
                <p
                  className="subtitle"
                  style={{ fontSize: '0.8rem', lineHeight: 1.5, margin: 0, marginBottom: '0.75rem' }}
                >
                  Time-series metrics registry scraping 12 services every 10s. Query{' '}
                  <code>http_requests_total</code>, <code>outbox_lag_seconds</code>, and circuit
                  breaker states.
                </p>
              </div>
              <a
                href="http://localhost:9090/targets"
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{
                  textAlign: 'center',
                  textDecoration: 'none',
                  fontSize: '0.75rem',
                  padding: '0.4rem 0.75rem',
                }}
              >
                View Scrape Targets & PromQL ↗
              </a>
            </div>

            {/* Live Gateway Metrics Card */}
            <div
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <strong style={{ fontSize: '0.95rem' }}>📡 Live Gateway Metrics Stream</strong>
                  <span className="pill pill-active" style={{ fontSize: '0.7rem' }}>
                    PORT 3000
                  </span>
                </div>
                <p
                  className="subtitle"
                  style={{ fontSize: '0.8rem', lineHeight: 1.5, margin: 0, marginBottom: '0.75rem' }}
                >
                  Direct Prometheus exposition stream from the API Gateway edge. Inspect raw counter
                  and histogram bucket distributions.
                </p>
              </div>
              <a
                href="http://localhost:3000/api/v1/metrics"
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{
                  textAlign: 'center',
                  textDecoration: 'none',
                  fontSize: '0.75rem',
                  padding: '0.4rem 0.75rem',
                }}
              >
                View /api/v1/metrics Raw ↗
              </a>
            </div>
          </div>
        </div>

        {/* Section 5: Live Operational Terminal Output */}
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
                            : log.source === 'RESILIENCE' || log.source === 'RABBITMQ'
                              ? 'var(--status-warn)'
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

        {/* Section 6: Real-Time Microservice Mesh Status */}
        <HealthMatrix />
      </div>
    </AuthGate>
  );
}
