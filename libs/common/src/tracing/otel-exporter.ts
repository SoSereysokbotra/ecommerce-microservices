import { Logger } from '@nestjs/common';
import { TraceSpan } from './trace-span';

export interface OtelExporterOptions {
  endpoint?: string;
  serviceName?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  enabled?: boolean;
}

/**
 * Lightweight, zero-dependency OpenTelemetry OTLP JSON HTTP Trace Exporter.
 * Targets Grafana Tempo or any OTLP/HTTP compliant collector (endpoint:4318/v1/traces).
 */
export class OtelExporter {
  private readonly logger = new Logger(OtelExporter.name);
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly enabled: boolean;

  private buffer: TraceSpan[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(options: OtelExporterOptions = {}) {
    const rawEndpoint =
      options.endpoint ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.TEMPO_ENDPOINT ||
      'http://localhost:4318';

    // Normalize endpoint to base URL without trailing slash or path
    this.endpoint = rawEndpoint.replace(/\/+$/, '').replace(/\/v1\/traces$/, '');
    this.serviceName = options.serviceName || process.env.SERVICE_NAME || 'commerce-service';
    this.batchSize = options.batchSize ?? 25;
    this.flushIntervalMs = options.flushIntervalMs ?? 1500;

    // Enabled if OTEL_ENABLED is not 'false' and an endpoint is defined
    const explicitEnabled = process.env.OTEL_ENABLED;
    this.enabled =
      options.enabled ??
      (explicitEnabled !== undefined
        ? explicitEnabled === 'true'
        : Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.TEMPO_ENDPOINT));

    if (this.enabled) {
      this.startTimer();
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Enqueue a completed span for batched export.
   */
  export(span: TraceSpan): void {
    if (!this.enabled) return;

    this.buffer.push(span);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Flush all buffered spans to the OTLP/HTTP collector.
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0 || this.isFlushing || !this.enabled) {
      return 0;
    }

    this.isFlushing = true;
    const spansToSend = [...this.buffer];
    this.buffer = [];

    try {
      // Group spans by service name
      const spansByService = new Map<string, TraceSpan[]>();
      for (const span of spansToSend) {
        const sName = span.serviceName || this.serviceName;
        const list = spansByService.get(sName) || [];
        list.push(span);
        spansByService.set(sName, list);
      }

      const resourceSpans = Array.from(spansByService.entries()).map(([serviceName, spans]) => ({
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: serviceName },
            },
            {
              key: 'telemetry.sdk.language',
              value: { stringValue: 'nodejs' },
            },
            {
              key: 'telemetry.sdk.name',
              value: { stringValue: '@libs/common' },
            },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: '@libs/common/tracing',
              version: '2.0.0',
            },
            spans: spans.map((s) => s.toOtlpSpan()),
          },
        ],
      }));

      const payload = { resourceSpans };
      const url = `${this.endpoint}/v1/traces`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        this.logger.debug(`OTLP trace export returned HTTP ${response.status} from ${url}`);
      }

      return spansToSend.length;
    } catch (err) {
      // Non-fatal: if collector is unreachable, silently drop rather than impacting service traffic
      this.logger.debug(
        `OTLP trace export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Shutdown the exporter, flushing remaining spans.
   */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  getBufferCount(): number {
    return this.buffer.length;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

let globalExporter: OtelExporter | null = null;

export function getGlobalOtelExporter(): OtelExporter {
  if (!globalExporter) {
    globalExporter = new OtelExporter();
  }
  return globalExporter;
}

export function setGlobalOtelExporter(exporter: OtelExporter): void {
  globalExporter = exporter;
}
