import { randomBytes } from 'crypto';
import { TraceContext, buildTraceparent } from './trace-context';

export enum SpanKind {
  INTERNAL = 0,
  SERVER = 1,
  CLIENT = 2,
  PRODUCER = 3,
  CONSUMER = 4,
}

export enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

export interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceSpanOptions {
  kind?: SpanKind;
  parentCtx?: TraceContext;
  attributes?: Record<string, string | number | boolean>;
  startTimeUnixNano?: string;
  serviceName?: string;
}

/**
 * OpenTelemetry-compliant trace span representation for distributed tracing.
 */
export class TraceSpan {
  public readonly name: string;
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly parentSpanId?: string;
  public readonly kind: SpanKind;
  public readonly traceparent: string;
  public readonly serviceName: string;
  public readonly startTimeUnixNano: string;
  public endTimeUnixNano?: string;
  public status: { code: SpanStatusCode; description?: string } = {
    code: SpanStatusCode.UNSET,
  };
  public attributes: Record<string, string | number | boolean> = {};
  public events: SpanEvent[] = [];

  constructor(name: string, options: TraceSpanOptions = {}) {
    this.name = name;
    this.kind = options.kind ?? SpanKind.INTERNAL;
    this.serviceName =
      options.serviceName ||
      options.parentCtx?.serviceName ||
      process.env.SERVICE_NAME ||
      'commerce-service';

    if (options.parentCtx) {
      this.traceId = options.parentCtx.traceId;
      this.parentSpanId = options.parentCtx.spanId;
    } else {
      this.traceId = randomBytes(16).toString('hex');
    }

    this.spanId = randomBytes(8).toString('hex');
    this.traceparent = buildTraceparent(
      this.traceId,
      this.spanId,
      options.parentCtx?.traceFlags ?? '01',
    );

    this.startTimeUnixNano =
      options.startTimeUnixNano ?? (BigInt(Date.now()) * 1000000n).toString();

    if (options.attributes) {
      this.attributes = { ...options.attributes };
    }
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  setStatus(code: SpanStatusCode, description?: string): this {
    this.status = { code, description };
    return this;
  }

  recordException(error: Error | unknown): this {
    this.status = {
      code: SpanStatusCode.ERROR,
      description: error instanceof Error ? error.message : String(error),
    };
    this.addEvent('exception', {
      'exception.type': error instanceof Error ? error.name : 'Error',
      'exception.message': error instanceof Error ? error.message : String(error),
      'exception.stacktrace': error instanceof Error ? (error.stack ?? '') : '',
    });
    return this;
  }

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this {
    this.events.push({
      name,
      timeUnixNano: (BigInt(Date.now()) * 1000000n).toString(),
      attributes,
    });
    return this;
  }

  end(endTimeUnixNano?: string): this {
    this.endTimeUnixNano = endTimeUnixNano ?? (BigInt(Date.now()) * 1000000n).toString();
    if (this.status.code === SpanStatusCode.UNSET) {
      this.status.code = SpanStatusCode.OK;
    }
    return this;
  }

  toOtlpSpan() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId ?? '',
      name: this.name,
      kind: this.kind,
      startTimeUnixNano: this.startTimeUnixNano,
      endTimeUnixNano: this.endTimeUnixNano ?? (BigInt(Date.now()) * 1000000n).toString(),
      attributes: Object.entries(this.attributes).map(([key, val]) => ({
        key,
        value:
          typeof val === 'string'
            ? { stringValue: val }
            : typeof val === 'number'
              ? Number.isInteger(val)
                ? { intValue: String(val) }
                : { doubleValue: val }
              : { boolValue: val },
      })),
      status: {
        code: this.status.code,
        message: this.status.description ?? '',
      },
      events: this.events.map((e) => ({
        name: e.name,
        timeUnixNano: e.timeUnixNano,
        attributes: e.attributes
          ? Object.entries(e.attributes).map(([key, val]) => ({
              key,
              value:
                typeof val === 'string'
                  ? { stringValue: val }
                  : typeof val === 'number'
                    ? { intValue: String(val) }
                    : { boolValue: val },
            }))
          : [],
      })),
    };
  }
}
