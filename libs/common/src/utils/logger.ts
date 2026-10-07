import { Logger, LoggerService } from '@nestjs/common';
import * as winston from 'winston';
import { getTraceContext } from '../tracing/trace-context';

export const appLogger = new Logger('CommercePlatform');

/**
 * Winston format that automatically extracts active trace context
 * from AsyncLocalStorage and enriches every log entry.
 */
const traceContextFormat = winston.format((info) => {
  const ctx = getTraceContext();
  if (ctx) {
    if (!info.traceId) info.traceId = ctx.traceId;
    if (!info.spanId) info.spanId = ctx.spanId;
    if (!info.correlationId) info.correlationId = ctx.correlationId;
  }
  return info;
});

const defaultFormat = winston.format.combine(
  traceContextFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production'
    ? winston.format.json()
    : winston.format.printf((info) => {
        const traceSnippet = info.traceId
          ? ` [trace:${(info.traceId as string).slice(0, 8)} corr:${info.correlationId ?? '-'}]`
          : info.correlationId
            ? ` [${info.correlationId}]`
            : '';
        const ctx = info.context ? ` [${info.context}]` : '';
        return `${info.timestamp} [${info.service ?? 'app'}] ${info.level.toUpperCase()}${ctx}: ${info.message}${traceSnippet}`;
      }),
);

export const createLogger = (serviceName: string) =>
  winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service: serviceName },
    format: defaultFormat,
    transports: [
      new winston.transports.Console({
        format:
          process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production'
            ? winston.format.json()
            : winston.format.combine(winston.format.colorize(), defaultFormat),
      }),
    ],
  });

/**
 * Drop-in NestJS LoggerService that automatically annotates logs with W3C
 * traceId, spanId, and correlationId.
 */
export class StructuredLogger implements LoggerService {
  private readonly logger: winston.Logger;

  constructor(
    private readonly serviceName: string = process.env.SERVICE_NAME ?? 'commerce-service',
  ) {
    this.logger = createLogger(this.serviceName);
  }

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(String(message), { trace, context });
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }

  verbose(message: unknown, context?: string): void {
    this.logger.verbose(String(message), { context });
  }
}
