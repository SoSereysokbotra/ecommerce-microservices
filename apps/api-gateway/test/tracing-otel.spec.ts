import {
  TraceSpan,
  SpanKind,
  SpanStatusCode,
  OtelExporter,
  setGlobalOtelExporter,
  createTraceContext,
  runWithTraceContext,
  startTraceSpan,
  getTraceContext,
  TRACEPARENT_HEADER,
} from '@libs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from '../src/resilience/circuit-breaker';
import { FallbackRegistry } from '../src/resilience/fallback';
import { ProxyService } from '../src/proxy/proxy.service';

describe('Phase 1: OpenTelemetry Distributed Tracing & Span Waterfalls', () => {
  describe('TraceSpan lifecycle and OTLP serialization', () => {
    it('creates an independent span with valid 32-hex traceId and 16-hex spanId', () => {
      const span = new TraceSpan('GET /api/v1/catalog/products', {
        kind: SpanKind.SERVER,
        serviceName: 'catalog-service',
      });

      expect(span.name).toBe('GET /api/v1/catalog/products');
      expect(span.kind).toBe(SpanKind.SERVER);
      expect(span.serviceName).toBe('catalog-service');
      expect(span.traceId).toHaveLength(32);
      expect(span.spanId).toHaveLength(16);
      expect(span.parentSpanId).toBeUndefined();
      expect(span.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it('inherits traceId and parentSpanId when parent context is provided', () => {
      const parent = createTraceContext({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        serviceName: 'api-gateway',
      });

      const childSpan = new TraceSpan('HTTP GET catalogServiceUrl', {
        kind: SpanKind.CLIENT,
        parentCtx: parent,
      });

      expect(childSpan.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(childSpan.parentSpanId).toBe(parent.spanId);
      expect(childSpan.spanId).not.toBe(parent.spanId);
    });

    it('records attributes, events, exceptions, and updates status correctly', () => {
      const span = new TraceSpan('checkout-transaction', { kind: SpanKind.INTERNAL });

      span.setAttribute('order.id', 'ord-123');
      span.setAttribute('order.total', 9950);
      span.setAttribute('order.is_guest', false);

      expect(span.attributes['order.id']).toBe('ord-123');
      expect(span.attributes['order.total']).toBe(9950);
      expect(span.attributes['order.is_guest']).toBe(false);

      span.recordException(new Error('Card declined by issuer'));

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.description).toBe('Card declined by issuer');
      expect(span.events).toHaveLength(1);
      expect(span.events[0].name).toBe('exception');
      expect(span.events[0].attributes?.['exception.message']).toBe('Card declined by issuer');

      span.end();
      expect(span.endTimeUnixNano).toBeDefined();
    });

    it('serializes span into standard OpenTelemetry OTLP JSON structure', () => {
      const span = new TraceSpan('GET /health', { kind: SpanKind.SERVER });
      span.setAttribute('http.status_code', 200);
      span.setAttribute('http.route', '/health');
      span.end();

      const otlp = span.toOtlpSpan();

      expect(otlp.traceId).toBe(span.traceId);
      expect(otlp.spanId).toBe(span.spanId);
      expect(otlp.name).toBe('GET /health');
      expect(otlp.kind).toBe(SpanKind.SERVER);
      expect(otlp.startTimeUnixNano).toBe(span.startTimeUnixNano);
      expect(otlp.endTimeUnixNano).toBe(span.endTimeUnixNano);
      expect(otlp.status.code).toBe(SpanStatusCode.OK);

      const statusAttr = otlp.attributes.find((a) => a.key === 'http.status_code');
      expect(statusAttr?.value).toEqual({ intValue: '200' });
    });
  });

  describe('OtelExporter buffering and delivery', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('buffers spans and flushes them to OTLP HTTP endpoint', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      global.fetch = mockFetch;

      const exporter = new OtelExporter({
        endpoint: 'http://tempo-test:4318',
        serviceName: 'test-service',
        enabled: true,
        batchSize: 5,
      });

      const span1 = new TraceSpan('span-1', { serviceName: 'test-service' }).end();
      const span2 = new TraceSpan('span-2', { serviceName: 'test-service' }).end();

      exporter.export(span1);
      exporter.export(span2);

      expect(exporter.getBufferCount()).toBe(2);

      const flushedCount = await exporter.flush();
      expect(flushedCount).toBe(2);
      expect(exporter.getBufferCount()).toBe(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://tempo-test:4318/v1/traces',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.resourceSpans).toBeDefined();
      expect(sentBody.resourceSpans[0].resource.attributes).toContainEqual({
        key: 'service.name',
        value: { stringValue: 'test-service' },
      });
      expect(sentBody.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);

      await exporter.shutdown();
    });

    it('handles exporter network failures gracefully without throwing to caller', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const exporter = new OtelExporter({
        endpoint: 'http://down-collector:4318',
        enabled: true,
      });

      const span = new TraceSpan('span-err').end();
      exporter.export(span);

      // Must not throw
      const flushed = await exporter.flush();
      expect(flushed).toBe(0);

      await exporter.shutdown();
    });
  });

  describe('API Gateway ProxyService Client Span Injection', () => {
    let proxyService: ProxyService;
    let configService: jest.Mocked<ConfigService>;
    let httpService: any;
    let circuitBreakerRegistry: CircuitBreakerRegistry;
    let fallbackRegistry: FallbackRegistry;
    const capturedSpans: TraceSpan[] = [];

    beforeEach(() => {
      capturedSpans.length = 0;
      const mockExporter = {
        export: (s: TraceSpan) => capturedSpans.push(s),
        flush: jest.fn().mockResolvedValue(0),
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as OtelExporter;
      setGlobalOtelExporter(mockExporter);

      configService = {
        get: jest.fn((key: string) => {
          if (key === 'catalogServiceUrl') return 'http://catalog-service:3002';
          if (key === 'upstreamTimeoutMs') return 1000;
          if (key === 'upstreamRetries') return 0;
          return undefined;
        }),
      } as any;

      httpService = {
        request: jest.fn(),
      };

      circuitBreakerRegistry = new CircuitBreakerRegistry(configService);
      fallbackRegistry = new FallbackRegistry();
      proxyService = new ProxyService(
        httpService,
        configService,
        circuitBreakerRegistry,
        fallbackRegistry,
      );
    });

    it('creates a CLIENT span, injects traceparent header, and records upstream status code', async () => {
      let passedHeaders: Record<string, string> = {};

      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async (cfg: any) => {
        passedHeaders = cfg.headers;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: [{ id: 'p1' }],
        };
      });

      const req: any = {
        method: 'GET',
        originalUrl: '/api/v1/catalog/products/p1',
        headers: {},
        correlationId: 'trace-test-corr-1',
      };

      const res = await proxyService.forward(req);

      expect(res.status).toBe(200);

      // Verifies outgoing headers carry the child span's W3C traceparent
      expect(passedHeaders[TRACEPARENT_HEADER]).toBeDefined();
      expect(passedHeaders[TRACEPARENT_HEADER]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      // Verifies CLIENT span was recorded and ended
      expect(capturedSpans.length).toBeGreaterThanOrEqual(1);
      const clientSpan = capturedSpans.find((s) => s.kind === SpanKind.CLIENT);
      expect(clientSpan).toBeDefined();
      expect(clientSpan?.name).toBe('HTTP GET catalogServiceUrl');
      expect(clientSpan?.attributes['http.status_code']).toBe(200);
      expect(clientSpan?.attributes['upstream.service']).toBe('catalogServiceUrl');
      expect(clientSpan?.traceparent).toBe(passedHeaders[TRACEPARENT_HEADER]);
    });
  });
});
