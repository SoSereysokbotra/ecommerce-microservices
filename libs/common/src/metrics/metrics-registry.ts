import { Counter, Gauge, Histogram, Metric } from './metric';

/**
 * Registry holding and formatting all Prometheus metrics for a service.
 */
export class MetricsRegistry {
  private metrics = new Map<string, Metric>();

  // Core RED HTTP metrics
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDurationSeconds: Histogram;

  // Transactional Outbox consistency & lag metrics
  readonly outboxPendingCount: Gauge;
  readonly outboxLagSeconds: Gauge;
  readonly outboxPublishedTotal: Counter;

  // Resilience & Queue health metrics
  readonly circuitBreakerState: Gauge;
  readonly dlqMessagesCount: Gauge;

  constructor() {
    this.httpRequestsTotal = this.registerCounter(
      'http_requests_total',
      'Total number of incoming HTTP requests processed',
    );

    this.httpRequestDurationSeconds = this.registerHistogram(
      'http_request_duration_seconds',
      'HTTP request latency in seconds',
    );

    this.outboxPendingCount = this.registerGauge(
      'outbox_pending_count',
      'Number of unpublished transactional outbox events awaiting broker dispatch',
    );

    this.outboxLagSeconds = this.registerGauge(
      'outbox_lag_seconds',
      'Age of the oldest unpublished transactional outbox event in seconds',
    );

    this.outboxPublishedTotal = this.registerCounter(
      'outbox_published_total',
      'Total number of transactional outbox events dispatched to the message broker',
    );

    this.circuitBreakerState = this.registerGauge(
      'circuit_breaker_state',
      'Circuit breaker status for upstreams: 0=CLOSED, 1=HALF_OPEN, 2=OPEN',
    );

    this.dlqMessagesCount = this.registerGauge(
      'dlq_messages_count',
      'Current number of quarantined messages residing in the Dead Letter Queue',
    );
  }

  registerCounter(name: string, help: string): Counter {
    const existing = this.metrics.get(name);
    if (existing && existing instanceof Counter) {
      return existing;
    }
    const counter = new Counter(name, help);
    this.metrics.set(name, counter);
    return counter;
  }

  registerGauge(name: string, help: string): Gauge {
    const existing = this.metrics.get(name);
    if (existing && existing instanceof Gauge) {
      return existing;
    }
    const gauge = new Gauge(name, help);
    this.metrics.set(name, gauge);
    return gauge;
  }

  registerHistogram(name: string, help: string, buckets?: number[]): Histogram {
    const existing = this.metrics.get(name);
    if (existing && existing instanceof Histogram) {
      return existing;
    }
    const histogram = new Histogram(name, help, buckets);
    this.metrics.set(name, histogram);
    return histogram;
  }

  getMetric<T extends Metric>(name: string): T | undefined {
    return this.metrics.get(name) as T | undefined;
  }

  reset(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  /**
   * Generates standard Prometheus exposition formatted plain text.
   */
  formatMetrics(): string {
    const sections: string[] = [];

    // 1. Process & Node.js runtime metrics
    const mem = process.memoryUsage();
    const serviceName = process.env.SERVICE_NAME || 'commerce-service';
    const sLabel = `{service="${serviceName}"}`;

    sections.push(
      [
        '# HELP process_resident_memory_bytes Resident memory size in bytes',
        '# TYPE process_resident_memory_bytes gauge',
        `process_resident_memory_bytes${sLabel} ${mem.rss}`,
        '# HELP process_heap_bytes Process heap size in bytes',
        '# TYPE process_heap_bytes gauge',
        `process_heap_bytes${sLabel} ${mem.heapUsed}`,
        '# HELP process_uptime_seconds Total process uptime in seconds',
        '# TYPE process_uptime_seconds gauge',
        `process_uptime_seconds${sLabel} ${process.uptime().toFixed(2)}`,
      ].join('\n'),
    );

    // 2. Custom registered metrics
    for (const metric of this.metrics.values()) {
      const formatted = metric.format().trim();
      if (formatted) {
        sections.push(formatted);
      }
    }

    return sections.join('\n\n') + '\n';
  }
}

let globalMetricsRegistry: MetricsRegistry | null = null;

export function getGlobalMetricsRegistry(): MetricsRegistry {
  if (!globalMetricsRegistry) {
    globalMetricsRegistry = new MetricsRegistry();
  }
  return globalMetricsRegistry;
}

export function setGlobalMetricsRegistry(registry: MetricsRegistry | null): void {
  globalMetricsRegistry = registry;
}
