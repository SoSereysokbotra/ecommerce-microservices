import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  TRACEPARENT_HEADER,
  createTraceContext,
  runWithTraceContext,
} from '../tracing/trace-context';

export { CORRELATION_ID_HEADER, TRACEPARENT_HEADER };

/**
 * Identity the gateway extracted from a verified JWT and forwards downstream.
 *
 * Services trust these because only the gateway is exposed; nothing else can
 * reach them. Sending the identity as headers rather than injecting it into the
 * request body keeps it available on GET and DELETE too, and leaves each
 * service's DTOs describing only what a caller actually sends.
 */
export const USER_ID_HEADER = 'x-user-id';
export const USER_ROLE_HEADER = 'x-user-role';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
    traceparent?: string;
    traceId?: string;
    spanId?: string;
  }
}

/**
 * Gives every request a correlation ID and standard W3C traceparent header that
 * follows it across service boundaries and message queues.
 *
 * Incoming trace context is extracted or freshly generated, attached to request
 * and response headers, and mounted in AsyncLocalStorage so all downstream
 * controllers, services, database queries, and event dispatches are automatically
 * bound to the same distributed trace.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawCorr = req.headers[CORRELATION_ID_HEADER];
    const rawTrace = req.headers[TRACEPARENT_HEADER];
    const rawUserId = req.headers[USER_ID_HEADER];
    const rawUserRole = req.headers[USER_ROLE_HEADER];

    const ctx = createTraceContext({
      correlationId: Array.isArray(rawCorr) ? rawCorr[0] : rawCorr,
      traceparent: Array.isArray(rawTrace) ? rawTrace[0] : rawTrace,
      userId: Array.isArray(rawUserId) ? rawUserId[0] : rawUserId,
      userRole: Array.isArray(rawUserRole) ? rawUserRole[0] : rawUserRole,
      serviceName: process.env.SERVICE_NAME,
    });

    req.correlationId = ctx.correlationId;
    req.headers[CORRELATION_ID_HEADER] = ctx.correlationId;
    res.setHeader(CORRELATION_ID_HEADER, ctx.correlationId);

    req.traceparent = ctx.traceparent;
    req.headers[TRACEPARENT_HEADER] = ctx.traceparent;
    res.setHeader(TRACEPARENT_HEADER, ctx.traceparent);

    req.traceId = ctx.traceId;
    req.spanId = ctx.spanId;

    // Run remaining middleware, guards, interceptors, and handlers inside the trace context
    runWithTraceContext(ctx, () => next());
  }
}
