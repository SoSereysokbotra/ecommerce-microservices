import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { getTraceContext, startTraceSpan } from '../tracing/trace-context';
import { SpanKind, SpanStatusCode } from '../tracing/trace-span';
import { getGlobalMetricsRegistry } from '../metrics/metrics-registry';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, originalUrl, url } = request;
    const path = originalUrl || url;
    const startedAt = Date.now();

    const traceCtx = getTraceContext();
    const correlationId = request.correlationId || traceCtx?.correlationId || '-';
    const traceId = request.traceId || traceCtx?.traceId;
    const spanId = request.spanId || traceCtx?.spanId;

    const span = startTraceSpan(`${method} ${path}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': method,
        'http.target': path,
        correlation_id: correlationId,
        ...(traceCtx?.userId ? { 'user.id': traceCtx.userId } : {}),
      },
    });

    return next.handle().pipe(
      tap({
        next: () => {
          const response = context.switchToHttp().getResponse();
          const duration = Date.now() - startedAt;
          const statusCode = response.statusCode;

          span.setAttribute('http.status_code', statusCode);
          if (statusCode >= 500) {
            span.setStatus(SpanStatusCode.ERROR, `HTTP ${statusCode}`);
          } else {
            span.setStatus(SpanStatusCode.OK);
          }
          span.end();

          const serviceName = process.env.SERVICE_NAME ?? 'commerce-service';
          const metricLabels = {
            method,
            route: path,
            status_code: String(statusCode),
            service: serviceName,
          };
          getGlobalMetricsRegistry().httpRequestsTotal.inc(metricLabels);
          getGlobalMetricsRegistry().httpRequestDurationSeconds.observe(
            duration / 1000,
            metricLabels,
          );

          if (process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production') {
            this.logger.log(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: 'info',
                service: serviceName,
                traceId,
                spanId,
                correlationId,
                method,
                path,
                statusCode,
                durationMs: duration,
              }),
            );
          } else {
            const traceSnippet = traceId
              ? ` [trace:${traceId.slice(0, 8)} corr:${correlationId}]`
              : ` [${correlationId}]`;
            this.logger.log(`${method} ${path} ${statusCode} - ${duration}ms${traceSnippet}`);
          }
        },
        error: (error: unknown) => {
          const duration = Date.now() - startedAt;
          const statusCode = (error as { status?: number })?.status || 500;
          const message = error instanceof Error ? error.message : String(error);

          span.setAttribute('http.status_code', statusCode);
          span.recordException(error);
          span.end();

          const serviceName = process.env.SERVICE_NAME ?? 'commerce-service';
          const metricLabels = {
            method,
            route: path,
            status_code: String(statusCode),
            service: serviceName,
          };
          getGlobalMetricsRegistry().httpRequestsTotal.inc(metricLabels);
          getGlobalMetricsRegistry().httpRequestDurationSeconds.observe(
            duration / 1000,
            metricLabels,
          );

          if (process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production') {
            this.logger.error(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: 'error',
                service: process.env.SERVICE_NAME ?? 'commerce-service',
                traceId,
                spanId,
                correlationId,
                method,
                path,
                statusCode,
                durationMs: duration,
                error: message,
              }),
            );
          } else {
            const traceSnippet = traceId
              ? ` [trace:${traceId.slice(0, 8)} corr:${correlationId}]`
              : ` [${correlationId}]`;
            this.logger.error(
              `${method} ${path} ${statusCode} - ${duration}ms${traceSnippet} Error: ${message}`,
            );
          }
        },
      }),
    );
  }
}
