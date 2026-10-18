import {
  Counter,
  Gauge,
  Histogram,
  formatLabels,
  MetricsRegistry,
  getGlobalMetricsRegistry,
} from '@libs/common';
import { HealthController } from '../src/health.controller';
import { CircuitBreaker } from '../src/resilience/circuit-breaker';

describe('Phase 3: Prometheus Metrics & Telemetry Exposition', () => {
  describe('formatLabels', () => {
    it('returns empty string when no labels provided', () => {
      expect(formatLabels()).toBe('');
      expect(formatLabels({})).toBe('');
    });

    it('formats and alphabetizes labels correctly with escaped values', () => {
      const labels = {
        status_code: '200',
        route: '/api/v1/orders',
        method: 'POST',
      };
      expect(formatLabels(labels)).toBe('{method="POST",route="/api/v1/orders",status_code="200"}');
    });
  });

  describe('Counter', () => {
    it('increments monotonically and formats into Prometheus text', () => {
      const counter = new Counter('test_requests_total', 'Total test requests');

      counter.inc({ method: 'GET', status: 200 });
      counter.inc({ method: 'GET', status: 200 }, 4);
      counter.inc({ method: 'POST', status: 201 });

      expect(counter.get({ method: 'GET', status: 200 })).toBe(5);
      expect(counter.get({ method: 'POST', status: 201 })).toBe(1);

      const formatted = counter.format();
      expect(formatted).toContain('# HELP test_requests_total Total test requests');
      expect(formatted).toContain('# TYPE test_requests_total counter');
      expect(formatted).toContain('test_requests_total{method="GET",status="200"} 5');
      expect(formatted).toContain('test_requests_total{method="POST",status="201"} 1');
    });

    it('throws error when incrementing by negative number', () => {
      const counter = new Counter('orders_total', 'Total orders');
      expect(() => counter.inc(undefined, -1)).toThrow();
    });
  });

  describe('Gauge', () => {
    it('sets, increments, and decrements scalar values', () => {
      const gauge = new Gauge('outbox_lag_seconds', 'Outbox lag in seconds');

      gauge.set(1.5, { service: 'orders-service' });
      expect(gauge.get({ service: 'orders-service' })).toBe(1.5);

      gauge.inc({ service: 'orders-service' }, 0.5);
      expect(gauge.get({ service: 'orders-service' })).toBe(2.0);

      gauge.dec({ service: 'orders-service' }, 1.2);
      expect(gauge.get({ service: 'orders-service' })).toBeCloseTo(0.8);

      const formatted = gauge.format();
      expect(formatted).toContain('# HELP outbox_lag_seconds Outbox lag in seconds');
      expect(formatted).toContain('# TYPE outbox_lag_seconds gauge');
      expect(formatted).toContain('outbox_lag_seconds{service="orders-service"} 0.8');
    });
  });

  describe('Histogram', () => {
    it('observes values into cumulative buckets, sum, and count', () => {
      const hist = new Histogram(
        'http_request_duration_seconds',
        'Request latency',
        [0.01, 0.05, 0.1, 0.5, 1.0],
      );

      hist.observe(0.005, { route: '/health' });
      hist.observe(0.02, { route: '/health' });
      hist.observe(0.08, { route: '/health' });
      hist.observe(0.6, { route: '/health' });

      const sample = hist.getSample({ route: '/health' });
      expect(sample).toBeDefined();
      expect(sample?.count).toBe(4);
      expect(sample?.sum).toBeCloseTo(0.705);

      const formatted = hist.format();
      expect(formatted).toContain('# HELP http_request_duration_seconds Request latency');
      expect(formatted).toContain('# TYPE http_request_duration_seconds histogram');
      expect(formatted).toContain(
        'http_request_duration_seconds_bucket{route="/health",le="0.01"} 1',
      );
      expect(formatted).toContain(
        'http_request_duration_seconds_bucket{route="/health",le="0.05"} 2',
      );
      expect(formatted).toContain(
        'http_request_duration_seconds_bucket{route="/health",le="0.1"} 3',
      );
      expect(formatted).toContain(
        'http_request_duration_seconds_bucket{route="/health",le="0.5"} 3',
      );
      expect(formatted).toContain('http_request_duration_seconds_bucket{route="/health",le="1"} 4');
      expect(formatted).toContain(
        'http_request_duration_seconds_bucket{route="/health",le="+Inf"} 4',
      );
      expect(formatted).toContain('http_request_duration_seconds_count{route="/health"} 4');
    });
  });

  describe('MetricsRegistry & HealthController exposition', () => {
    it('pre-registers standard telemetry and formats Prometheus exposition', () => {
      const registry = new MetricsRegistry();

      registry.httpRequestsTotal.inc({
        method: 'GET',
        route: '/api/v1/orders',
        service: 'api-gateway',
        status_code: 200,
      });

      registry.httpRequestDurationSeconds.observe(0.045, {
        method: 'GET',
        route: '/api/v1/orders',
        service: 'api-gateway',
        status_code: 200,
      });

      registry.outboxPendingCount.set(3, { service: 'orders-service' });
      registry.outboxLagSeconds.set(0.125, { service: 'orders-service' });
      registry.outboxPublishedTotal.inc({ service: 'orders-service', event_type: 'order.created' });

      registry.circuitBreakerState.set(0, { service_key: 'ordersServiceUrl' });

      const text = registry.formatMetrics();

      // Standard node runtime process metrics
      expect(text).toContain('process_resident_memory_bytes');
      expect(text).toContain('process_heap_bytes');
      expect(text).toContain('process_uptime_seconds');

      // Core RED metrics
      expect(text).toContain(
        'http_requests_total{method="GET",route="/api/v1/orders",service="api-gateway",status_code="200"} 1',
      );
      expect(text).toContain(
        'http_request_duration_seconds_count{method="GET",route="/api/v1/orders",service="api-gateway",status_code="200"} 1',
      );

      // Outbox consistency & lag metrics
      expect(text).toContain('outbox_pending_count{service="orders-service"} 3');
      expect(text).toContain('outbox_lag_seconds{service="orders-service"} 0.125');
      expect(text).toContain(
        'outbox_published_total{event_type="order.created",service="orders-service"} 1',
      );

      // Circuit breaker metrics
      expect(text).toContain('circuit_breaker_state{service_key="ordersServiceUrl"} 0');
    });

    it('HealthController.metrics() exposes live Prometheus payload', () => {
      const controller = new HealthController();
      const output = controller.metrics();
      expect(typeof output).toBe('string');
      expect(output).toContain('process_resident_memory_bytes');
      expect(output).toContain('process_heap_bytes');
      expect(output).toContain('process_uptime_seconds');
    });

    it('CircuitBreaker transitions update circuit_breaker_state gauge', () => {
      const cb = new CircuitBreaker('paymentsServiceUrl', {
        failureThreshold: 2,
        recoveryTimeoutMs: 100,
      });

      const registry = getGlobalMetricsRegistry();
      expect(registry.circuitBreakerState.get({ service_key: 'paymentsServiceUrl' })).toBe(0); // CLOSED

      cb.recordFailure(new Error('Downstream error'));
      cb.recordFailure(new Error('Downstream error')); // Trips to OPEN
      expect(cb.isOpen()).toBe(true);
      expect(registry.circuitBreakerState.get({ service_key: 'paymentsServiceUrl' })).toBe(2); // OPEN

      cb.reset();
      expect(cb.isOpen()).toBe(false);
      expect(registry.circuitBreakerState.get({ service_key: 'paymentsServiceUrl' })).toBe(0); // CLOSED
    });
  });
});
