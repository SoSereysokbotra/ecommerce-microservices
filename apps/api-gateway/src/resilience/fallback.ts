import { Injectable } from '@nestjs/common';
import { AxiosResponse } from 'axios';

export interface FallbackHandler {
  matches(method: string, path: string): boolean;
  createFallback(path: string, reason: string): AxiosResponse;
}

/**
 * Registry of graceful fallback policies for non-critical read projections.
 * Protects the user experience by substituting empty/default projections instead
 * of throwing 500/503 errors when non-critical downstream services are dead or degraded.
 */
@Injectable()
export class FallbackRegistry {
  private readonly handlers: FallbackHandler[] = [];

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    // 1. Recommendations discovery: GET /api/v1/recommendations/products/:id
    this.register({
      matches: (method, path) => method === 'GET' && /^\/api\/v1\/recommendations(\/|$)/.test(path),
      createFallback: (_path, reason) => this.buildResponse(200, { items: [], total: 0 }, reason),
    });

    // 2. Reviews eligibility check: GET /api/v1/reviews/products/:id/eligibility
    this.register({
      matches: (method, path) =>
        method === 'GET' && /^\/api\/v1\/reviews\/products\/[^/]+\/eligibility(\/|$)/.test(path),
      createFallback: (_path, reason) =>
        this.buildResponse(
          200,
          { canReview: false, reason: 'Reviews service temporarily unavailable' },
          reason,
        ),
    });

    // 3. Product reviews listing: GET /api/v1/reviews/products/:id
    this.register({
      matches: (method, path) =>
        method === 'GET' && /^\/api\/v1\/reviews\/products(\/|$)/.test(path),
      createFallback: (_path, reason) =>
        this.buildResponse(200, { items: [], rating: null, total: 0, page: 1, limit: 10 }, reason),
    });

    // 4. Product search index: GET /api/v1/search
    this.register({
      matches: (method, path) => method === 'GET' && /^\/api\/v1\/search(\/|$)/.test(path),
      createFallback: (_path, reason) =>
        this.buildResponse(
          200,
          { hits: [], total: 0, page: 1, limit: 10, facets: { categories: [] } },
          reason,
        ),
    });
  }

  register(handler: FallbackHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Only safe, idempotent read requests (GET, HEAD) are eligible for fallback.
   * Write operations (POST, PUT, PATCH, DELETE) must ALWAYS fail fast to prevent
   * false-positive write confirmation.
   */
  getFallback(method: string, path: string, reason: string): AxiosResponse | null {
    if (method !== 'GET' && method !== 'HEAD') {
      return null;
    }

    for (const handler of this.handlers) {
      if (handler.matches(method, path)) {
        return handler.createFallback(path, reason);
      }
    }

    return null;
  }

  private buildResponse(status: number, data: unknown, reason: string): AxiosResponse {
    return {
      status,
      statusText: 'OK (Degraded Fallback)',
      headers: {
        'content-type': 'application/json',
        'x-degraded': 'true',
        'x-degraded-reason': reason,
      },
      config: { headers: {} } as AxiosResponse['config'],
      data,
    };
  }
}
