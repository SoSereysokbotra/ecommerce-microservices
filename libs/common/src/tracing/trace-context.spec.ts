import {
  parseTraceparent,
  generateTraceIds,
  buildTraceparent,
  createTraceContext,
  createChildSpanContext,
  runWithTraceContext,
  getTraceContext,
  getTraceId,
  getSpanId,
  getCorrelationId,
  getTraceparent,
} from './trace-context';

describe('trace-context', () => {
  describe('parseTraceparent', () => {
    it('parses valid W3C traceparent', () => {
      const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const parsed = parseTraceparent(header);
      expect(parsed).toEqual({
        version: '00',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: '01',
      });
    });

    it('rejects all-zeros traceId or spanId', () => {
      expect(
        parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
      ).toBeNull();
      expect(
        parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'),
      ).toBeNull();
    });

    it('rejects version ff and invalid strings', () => {
      expect(
        parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
      ).toBeNull();
      expect(parseTraceparent('invalid-traceparent')).toBeNull();
      expect(parseTraceparent(undefined)).toBeNull();
    });

    it('generates valid IDs and builds formatted traceparent', () => {
      const { traceId, spanId } = generateTraceIds();
      expect(traceId).toHaveLength(32);
      expect(spanId).toHaveLength(16);

      const header = buildTraceparent(traceId, spanId);
      expect(header).toBe(`00-${traceId}-${spanId}-01`);
    });
  });

  describe('createTraceContext & child spans', () => {
    it('creates fresh context with valid 32-hex traceId and 16-hex spanId when none provided', () => {
      const ctx = createTraceContext();
      expect(ctx.traceId).toHaveLength(32);
      expect(ctx.spanId).toHaveLength(16);
      expect(ctx.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(ctx.correlationId).toBe(ctx.traceId);
    });

    it('preserves existing traceId and adopts incoming parent spanId', () => {
      const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const ctx = createTraceContext({ traceparent: incoming, correlationId: 'custom-corr-1' });

      expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(ctx.parentSpanId).toBe('00f067aa0ba902b7');
      expect(ctx.spanId).not.toBe('00f067aa0ba902b7'); // generated new spanId
      expect(ctx.correlationId).toBe('custom-corr-1');
    });

    it('creates child span with same traceId but distinct spanId', () => {
      const parent = createTraceContext();
      const child = createChildSpanContext(parent);

      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      expect(child.spanId).not.toBe(parent.spanId);
      expect(child.correlationId).toBe(parent.correlationId);
    });
  });

  describe('runWithTraceContext & AsyncLocalStorage', () => {
    it('provides context inside execution callback and clears outside', () => {
      const ctx = createTraceContext({ correlationId: 'req-abc' });

      expect(getTraceContext()).toBeUndefined();
      expect(getCorrelationId()).toBeUndefined();

      runWithTraceContext(ctx, () => {
        expect(getTraceContext()).toBe(ctx);
        expect(getCorrelationId()).toBe('req-abc');
        expect(getTraceId()).toBe(ctx.traceId);
        expect(getSpanId()).toBe(ctx.spanId);
        expect(getTraceparent()).toBe(ctx.traceparent);
      });

      expect(getTraceContext()).toBeUndefined();
    });
  });
});
