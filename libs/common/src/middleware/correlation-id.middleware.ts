import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

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
  }
}

/**
 * Gives every request an id that follows it across service boundaries.
 *
 * The gateway generates one when the caller did not supply it; downstream
 * services reuse whatever arrives. Without this, a single user action produces
 * unrelated log lines in five services with no way to join them.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    req.correlationId = correlationId;
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}
