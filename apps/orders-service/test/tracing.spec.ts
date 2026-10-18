import {
  createTraceContext,
  createChildSpanContext,
  parseTraceparent,
  runWithTraceContext,
  getTraceContext,
  getCorrelationId,
  getTraceId,
  getTraceparent,
  TraceSpan,
  SpanKind,
  SpanStatusCode,
  getGlobalOtelExporter,
} from '@libs/common';
import { RabbitMQService } from '@libs/rabbitmq';
import { OutboxRelay } from '@libs/outbox';

describe('Distributed Tracing Context Propagation', () => {
  it('parses valid W3C traceparent and creates child span context', () => {
    const rawTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parsed = parseTraceparent(rawTraceparent);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');

    const ctx = createTraceContext({
      traceparent: rawTraceparent,
      correlationId: 'req-order-checkout-123',
    });

    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx.correlationId).toBe('req-order-checkout-123');

    const child = createChildSpanContext(ctx);
    expect(child.traceId).toBe(ctx.traceId);
    expect(child.parentSpanId).toBe(ctx.spanId);
    expect(child.spanId).not.toBe(ctx.spanId);
    expect(child.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  });

  it('runs within AsyncLocalStorage and isolates trace contexts', () => {
    const ctx = createTraceContext({ correlationId: 'order-trace-test' });

    expect(getTraceContext()).toBeUndefined();

    runWithTraceContext(ctx, () => {
      expect(getTraceContext()).toBe(ctx);
      expect(getCorrelationId()).toBe('order-trace-test');
      expect(getTraceId()).toBe(ctx.traceId);
      expect(getTraceparent()).toBe(ctx.traceparent);
    });

    expect(getTraceContext()).toBeUndefined();
  });
});

describe('Phase 2: Outbox & RabbitMQ Distributed Tracing Integration', () => {
  let otelExportSpy: jest.SpyInstance;

  beforeEach(() => {
    otelExportSpy = jest.spyOn(getGlobalOtelExporter(), 'export').mockImplementation(() => {});
  });

  afterEach(() => {
    otelExportSpy.mockRestore();
  });

  it('OutboxRelay instrumented with PRODUCER span linked to outbox traceparent', async () => {
    const mockRabbitmq = {
      publishOrThrow: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
    };

    const mockDataSource = {
      transaction: jest.fn(),
    };

    const relay = new OutboxRelay(mockDataSource as any, mockRabbitmq as any, {
      pollIntervalMs: 5000,
      batchSize: 10,
    });

    const rootTraceparent = '00-55555555555555555555555555555555-1111111111111111-01';
    const mockRow = {
      id: 'row-1',
      event_id: 'evt-100',
      event_type: 'order.created',
      aggregate_id: 'ord-999',
      correlation_id: 'corr-999',
      version: 1,
      payload: {
        orderId: 'ord-999',
        total: 100,
        traceparent: rootTraceparent,
      },
      created_at: new Date(),
    };

    const mockManager = {
      query: jest.fn().mockResolvedValue(undefined),
    };

    const published = await (relay as any).publishOne(mockManager, mockRow);
    expect(published).toBe(true);

    // RabbitMQ publishOrThrow received envelope with new child traceparent
    expect(mockRabbitmq.publishOrThrow).toHaveBeenCalledWith(
      'order.created',
      expect.objectContaining({
        eventId: 'evt-100',
        eventType: 'order.created',
        aggregateId: 'ord-999',
        correlationId: 'corr-999',
        traceparent: expect.stringMatching(/^00-55555555555555555555555555555555-[0-9a-f]{16}-01$/),
      }),
    );

    // PRODUCER span was exported to OtelExporter
    expect(otelExportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'outbox.relay order.created',
        kind: SpanKind.PRODUCER,
        traceId: '55555555555555555555555555555555',
        parentSpanId: '1111111111111111',
        status: { code: SpanStatusCode.OK },
      }),
    );
  });

  it('RabbitMQService.consume creates CONSUMER span and runs handler within trace context', async () => {
    const mockChannel = {
      consume: jest.fn(),
      ack: jest.fn(),
    };

    const rmq = new RabbitMQService({
      url: 'amqp://localhost:5672',
      queue: 'inventory-service',
    });
    (rmq as any).channel = mockChannel;

    let registeredConsumer: ((msg: any) => Promise<void>) | null = null;
    mockChannel.consume.mockImplementation((_queue: string, cb: any) => {
      registeredConsumer = cb;
      return Promise.resolve({ consumerTag: 'tag-inv' });
    });

    let executedInTraceContext: any = null;
    const testHandler = jest.fn().mockImplementation(async () => {
      executedInTraceContext = getTraceContext();
    });

    await rmq.subscribe('inventory-service', testHandler);
    expect(registeredConsumer).not.toBeNull();

    const incomingTraceparent = '00-77777777777777777777777777777777-2222222222222222-01';
    const testMessage = {
      fields: { routingKey: 'order.created' },
      properties: {
        headers: {
          traceparent: incomingTraceparent,
          'x-correlation-id': 'corr-flow-42',
        },
      },
      content: Buffer.from(
        JSON.stringify({
          orderId: 'ord-abc',
          traceparent: incomingTraceparent,
        }),
      ),
    };

    await (registeredConsumer as any)(testMessage);

    // Verify handler executed inside child trace context
    expect(testHandler).toHaveBeenCalledTimes(1);
    expect(executedInTraceContext).toBeDefined();
    expect(executedInTraceContext.traceId).toBe('77777777777777777777777777777777');
    expect(executedInTraceContext.parentSpanId).toBe('2222222222222222');
    expect(mockChannel.ack).toHaveBeenCalledWith(testMessage);

    // Verify CONSUMER span exported
    expect(otelExportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'rabbitmq.consume order.created',
        kind: SpanKind.CONSUMER,
        traceId: '77777777777777777777777777777777',
        parentSpanId: '2222222222222222',
        status: { code: SpanStatusCode.OK },
      }),
    );
  });

  it('Traces end-to-end: OutboxRelay PRODUCER -> RabbitMQ CONSUMER unbroken waterfall', async () => {
    // 1. Initial order checkout request context (from HTTP SERVER span)
    const initialHttpTrace = createTraceContext({
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      correlationId: 'checkout-wf-101',
      serviceName: 'orders-service',
    });

    // 2. Outbox relay drains and publishes row created by orders-service
    let publishedEnvelope: any = null;
    const mockRabbitmq = {
      publishOrThrow: jest.fn().mockImplementation(async (_key: string, env: any) => {
        publishedEnvelope = env;
      }),
      isConnected: jest.fn().mockReturnValue(true),
    };

    const relay = new OutboxRelay({} as any, mockRabbitmq as any, {
      pollIntervalMs: 5000,
      batchSize: 10,
    });

    const outboxRow = {
      id: 'row-e2e',
      event_id: 'evt-e2e',
      event_type: 'order.created',
      aggregate_id: 'ord-wf',
      correlation_id: initialHttpTrace.correlationId,
      version: 1,
      payload: {
        orderId: 'ord-wf',
        traceparent: initialHttpTrace.traceparent,
      },
      created_at: new Date(),
    };

    const mockManager = {
      query: jest.fn().mockResolvedValue(undefined),
    };

    await (relay as any).publishOne(mockManager as any, outboxRow);

    expect(publishedEnvelope).not.toBeNull();
    const producerSpanExported = otelExportSpy.mock.calls[0][0] as TraceSpan;
    expect(producerSpanExported.kind).toBe(SpanKind.PRODUCER);
    expect(producerSpanExported.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(producerSpanExported.parentSpanId).toBe(initialHttpTrace.spanId);

    // 3. Downstream consumer (e.g. inventory-service) receives published envelope
    let consumerChannelConsumeCb: any = null;
    const mockInvChannel = {
      consume: jest.fn().mockImplementation((_q: string, cb: any) => {
        consumerChannelConsumeCb = cb;
        return Promise.resolve({ consumerTag: 'tag-inv' });
      }),
      ack: jest.fn(),
    };

    const invRmq = new RabbitMQService({
      url: 'amqp://localhost:5672',
      queue: 'inventory-service',
    });
    (invRmq as any).channel = mockInvChannel;

    let consumerCapturedContext: any = null;
    await invRmq.subscribe('inventory-service', async () => {
      consumerCapturedContext = getTraceContext();
    });

    // Deliver published message to consumer
    await consumerChannelConsumeCb({
      fields: { routingKey: 'order.created' },
      properties: {
        headers: {
          traceparent: publishedEnvelope.traceparent,
          'x-correlation-id': publishedEnvelope.correlationId,
        },
      },
      content: Buffer.from(JSON.stringify(publishedEnvelope)),
    });

    const consumerSpanExported = otelExportSpy.mock.calls[1][0] as TraceSpan;
    expect(consumerSpanExported.kind).toBe(SpanKind.CONSUMER);

    // UNBROKEN WATERFALL VERIFICATION:
    // Both spans share the exact same root traceId
    expect(producerSpanExported.traceId).toBe(consumerSpanExported.traceId);
    expect(consumerSpanExported.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Consumer span's parentSpanId is the producer span's spanId
    expect(consumerSpanExported.parentSpanId).toBe(producerSpanExported.spanId);

    // Any async work inside the consumer handler inherits this traceId
    expect(consumerCapturedContext.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
