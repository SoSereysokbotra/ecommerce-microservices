import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

export const TRACEPARENT_HEADER = 'traceparent';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const TRACESTATE_HEADER = 'tracestate';

export interface TraceContext {
  /** W3C 32-hex character trace identifier */
  traceId: string;
  /** Current 16-hex character span identifier */
  spanId: string;
  /** Parent 16-hex character span identifier, if any */
  parentSpanId?: string;
  /** Formatted W3C traceparent header: 00-{traceId}-{spanId}-{flags} */
  traceparent: string;
  /** High-level cross-service correlation identifier */
  correlationId: string;
  /** Optional authenticated user identifier */
  userId?: string;
  /** Optional user role */
  userRole?: string;
  /** Service context executing this work */
  serviceName?: string;
  /** W3C trace flags: '01' = sampled, '00' = not sampled */
  traceFlags?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Regex validating W3C traceparent: version-traceId-spanId-traceFlags */
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * Validates and parses a W3C traceparent header value.
 * Returns null if the header is malformed, not 4-part hex, or invalid (e.g. all zeros).
 */
export function parseTraceparent(
  header?: string | string[],
): { version: string; traceId: string; spanId: string; traceFlags: string } | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || typeof raw !== 'string') return null;

  const match = raw.trim().toLowerCase().match(TRACEPARENT_REGEX);
  if (!match) return null;

  const [, version, traceId, spanId, traceFlags] = match;

  // TraceId and spanId cannot be all zeros
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return null;
  }

  // Version 'ff' is explicitly prohibited by W3C specification
  if (version === 'ff') {
    return null;
  }

  return { version, traceId, spanId, traceFlags };
}

/**
 * Generates a valid 32-hex trace ID (16 bytes) and 16-hex span ID (8 bytes).
 */
export function generateTraceIds(): { traceId: string; spanId: string } {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
}

/**
 * Generates a standard W3C traceparent header string.
 */
export function buildTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/**
 * Creates or extracts a valid TraceContext given incoming headers or existing values.
 */
export function createTraceContext(options?: {
  traceparent?: string | string[];
  correlationId?: string | string[];
  userId?: string;
  userRole?: string;
  serviceName?: string;
}): TraceContext {
  const parsed = parseTraceparent(options?.traceparent);
  let traceId: string;
  let spanId: string;
  let parentSpanId: string | undefined;
  let traceFlags = '01';

  if (parsed) {
    traceId = parsed.traceId;
    parentSpanId = parsed.spanId;
    // Generate a new span ID representing this service's execution span
    spanId = randomBytes(8).toString('hex');
    traceFlags = parsed.traceFlags;
  } else {
    const ids = generateTraceIds();
    traceId = ids.traceId;
    spanId = ids.spanId;
  }

  const incomingCorr = Array.isArray(options?.correlationId)
    ? options?.correlationId[0]
    : options?.correlationId;

  // Use incoming correlation ID if present, otherwise default to traceId
  const correlationId = (incomingCorr && incomingCorr.trim()) || traceId;

  return {
    traceId,
    spanId,
    parentSpanId,
    traceparent: buildTraceparent(traceId, spanId, traceFlags),
    correlationId,
    userId: options?.userId,
    userRole: options?.userRole,
    serviceName: options?.serviceName,
    traceFlags,
  };
}

/**
 * Creates a child span context from an existing parent TraceContext (for downstream HTTP or AMQP).
 */
export function createChildSpanContext(parent?: TraceContext): TraceContext {
  if (!parent) {
    return createTraceContext();
  }

  const childSpanId = randomBytes(8).toString('hex');
  return {
    ...parent,
    parentSpanId: parent.spanId,
    spanId: childSpanId,
    traceparent: buildTraceparent(parent.traceId, childSpanId, parent.traceFlags ?? '01'),
  };
}

/**
 * Runs a function within the asynchronous storage boundary of a TraceContext.
 */
export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Retrieves the currently active TraceContext, if one exists in the execution stack.
 */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Convenience helper to get the active trace ID or undefined.
 */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Convenience helper to get the active span ID or undefined.
 */
export function getSpanId(): string | undefined {
  return storage.getStore()?.spanId;
}

/**
 * Convenience helper to get the active correlation ID or undefined.
 */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Convenience helper to get the active W3C traceparent header or undefined.
 */
export function getTraceparent(): string | undefined {
  return storage.getStore()?.traceparent;
}
