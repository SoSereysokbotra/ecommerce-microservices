import {
  createTraceContext,
  createChildSpanContext,
  parseTraceparent,
  runWithTraceContext,
  getTraceContext,
  getCorrelationId,
  getTraceId,
  getTraceparent,
} from '@libs/common';

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
