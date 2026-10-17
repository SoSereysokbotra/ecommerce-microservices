import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { CircuitBreakerRegistry } from '../src/resilience/circuit-breaker';
import { FallbackRegistry } from '../src/resilience/fallback';
import { ProxyService } from '../src/proxy/proxy.service';

describe('Phase 4: Automated Chaos & Resilience Concurrency Tests', () => {
  let proxyService: ProxyService;
  let circuitBreakerRegistry: CircuitBreakerRegistry;
  let fallbackRegistry: FallbackRegistry;

  const mockConfig: Record<string, any> = {
    catalogServiceUrl: 'http://catalog-service:3002',
    ordersServiceUrl: 'http://orders-service:3004',
    paymentsServiceUrl: 'http://payments-service:3005',
    recommendationsServiceUrl: 'http://recommendations-service:3011',
    reviewsServiceUrl: 'http://reviews-service:3010',
    searchServiceUrl: 'http://search-service:3009',
    upstreamTimeoutMs: 1000,
    upstreamRetries: 0,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerRecoveryTimeoutMs: 300,
    circuitBreakerHalfOpenMaxTrials: 2,
  };

  const fakeConfigService = {
    get: jest.fn((key: string) => mockConfig[key]),
  } as unknown as ConfigService;

  const fakeHttpService: any = {
    axiosRef: {
      request: jest.fn(),
    },
  };

  beforeEach(() => {
    circuitBreakerRegistry = new CircuitBreakerRegistry(fakeConfigService);
    fallbackRegistry = new FallbackRegistry();
    proxyService = new ProxyService(
      fakeHttpService,
      fakeConfigService,
      circuitBreakerRegistry,
      fallbackRegistry,
    );
    jest.clearAllMocks();
  });

  describe('Chaos Burst on Failing Upstream (Fast-Fail Storm Protection)', () => {
    it('trips circuit after threshold and immediately fast-fails remaining concurrent requests', async () => {
      // Simulate network transport failure
      let networkCallCount = 0;
      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async () => {
        networkCallCount++;
        const err: any = new Error('ECONNREFUSED: Connection refused');
        err.code = 'ECONNREFUSED';
        throw err;
      });

      // 1. Initial 5 failures trip the breaker to OPEN
      for (let i = 0; i < 5; i++) {
        await expect(
          proxyService.forward({
            method: 'GET',
            originalUrl: `/api/v1/catalog/products/fail-${i}`,
            headers: { 'x-correlation-id': `fail-${i}` },
          } as any),
        ).rejects.toThrow(HttpException);
      }

      // Verify circuit breaker is now OPEN
      const breaker = circuitBreakerRegistry.getBreaker('catalogServiceUrl');
      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.getSnapshot().consecutiveFailures).toBe(5);
      expect(networkCallCount).toBe(5);

      // 2. Send a storm of 15 concurrent requests while circuit is OPEN
      const stormSize = 15;
      const requests = Array.from({ length: stormSize }, (_, i) => ({
        method: 'GET',
        originalUrl: `/api/v1/catalog/products/p${i}`,
        headers: { 'x-correlation-id': `storm-corr-${i}` },
      }));

      const results = await Promise.allSettled(
        requests.map((req) => proxyService.forward(req as any)),
      );

      // Verify all 15 requests were fast-failed with 503 Service Unavailable
      expect(results.length).toBe(stormSize);
      for (const res of results) {
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.reason).toBeInstanceOf(HttpException);
          expect(res.reason.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
          expect(res.reason.getResponse()).toMatchObject({
            statusCode: 503,
            circuitStatus: 'OPEN',
            retryAfterSeconds: expect.any(Number),
          });
        }
      }

      // Crucial: zero additional network calls made. The gateway stopped all 15 at edge!
      expect(networkCallCount).toBe(5);

      // Subsequent single call must fast-fail in < 25ms without network invocation
      const t0 = Date.now();
      await expect(
        proxyService.forward({
          method: 'GET',
          originalUrl: '/api/v1/catalog/products/immediate',
          headers: {},
        } as any),
      ).rejects.toThrow(HttpException);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(25);
    });
  });

  describe('Chaos Storm on Non-Critical Projections (Graceful Degradation Guarantee)', () => {
    it('resolves 100% of concurrent failing recommendation requests with degraded HTTP 200 fallbacks', async () => {
      jest.spyOn(proxyService as any, 'sendWithRetry').mockRejectedValue({
        code: 'ECONNRESET',
        message: 'recommendations-service crashed',
      });

      const stormSize = 25;
      const requests = Array.from({ length: stormSize }, (_, i) => ({
        method: 'GET',
        originalUrl: `/api/v1/recommendations/products/p${i}`,
        headers: { 'x-correlation-id': `rec-storm-${i}` },
      }));

      const results = await Promise.all(requests.map((req) => proxyService.forward(req as any)));

      // All 25 requests MUST succeed with 200 and return fallback data
      expect(results.length).toBe(stormSize);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.headers['x-degraded']).toBe('true');
        expect(res.headers['x-degraded-reason']).toBeDefined();
        expect(res.data).toEqual({
          items: [],
          total: 0,
        });
      }

      // Breaker for recommendationsServiceUrl tripped to OPEN
      const breaker = circuitBreakerRegistry.getBreaker('recommendationsServiceUrl');
      expect(breaker.getState()).toBe('OPEN');

      // Even when breaker is OPEN, subsequent recommendation requests still return 200 degraded!
      const subsequent = await proxyService.forward({
        method: 'GET',
        originalUrl: '/api/v1/recommendations/products/subsequent',
        headers: {},
      } as any);

      expect(subsequent.status).toBe(200);
      expect(subsequent.headers['x-degraded']).toBe('true');
      expect(subsequent.headers['x-degraded-reason']).toBe(
        'circuit_open_recommendationsServiceUrl',
      );
      expect(subsequent.data).toEqual({ items: [], total: 0 });
    });
  });

  describe('Strict Zero-Degradation Invariant for Mutating & Financial Paths', () => {
    it('NEVER returns degraded fallbacks for POST /orders under chaos; strictly fails fast', async () => {
      jest.spyOn(proxyService as any, 'sendWithRetry').mockRejectedValue({
        code: 'ECONNREFUSED',
        message: 'orders-service unavailable',
      });

      // Trip the breaker to OPEN
      const breaker = circuitBreakerRegistry.getBreaker('ordersServiceUrl');
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(new Error('Down'));
      }
      expect(breaker.getState()).toBe('OPEN');

      const stormSize = 10;
      const requests = Array.from({ length: stormSize }, (_, i) => ({
        method: 'POST',
        originalUrl: '/api/v1/orders',
        headers: { 'x-correlation-id': `order-chaos-${i}` },
        body: { items: [{ productId: 'p1', quantity: 1 }] },
      }));

      const results = await Promise.allSettled(
        requests.map((req) => proxyService.forward(req as any)),
      );

      // Crucial: ALL 10 mutating calls must be rejected with 503
      for (const res of results) {
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.reason).toBeInstanceOf(HttpException);
          expect(res.reason.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
          expect(res.reason.getResponse()).toMatchObject({
            statusCode: 503,
            error: 'Service Unavailable',
            circuitStatus: 'OPEN',
            retryAfterSeconds: expect.any(Number),
          });
        }
      }
    });

    it('NEVER returns degraded fallbacks for POST /payments under chaos; strictly fails fast', async () => {
      const breaker = circuitBreakerRegistry.getBreaker('paymentsServiceUrl');
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(new Error('Payments down'));
      }
      expect(breaker.getState()).toBe('OPEN');

      await expect(
        proxyService.forward({
          method: 'POST',
          originalUrl: '/api/v1/payments/process',
          headers: {},
        } as any),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('Dynamic Recovery Cycle (OPEN -> HALF_OPEN -> CLOSED)', () => {
    it('transitions to HALF_OPEN after recovery timeout and recovers to CLOSED after trial threshold', async () => {
      // 1. Trip breaker to OPEN
      const breaker = circuitBreakerRegistry.getBreaker('catalogServiceUrl');
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(new Error('fail'));
      }
      expect(breaker.getState()).toBe('OPEN');

      // 2. Wait for recovery timeout (500ms)
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // 3. Mock successful responses for trials
      jest.spyOn(proxyService as any, 'sendWithRetry').mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: [{ id: 'p1', name: 'Product 1' }],
      });

      // Trial 1: Succeeds
      const trial1 = await proxyService.forward({
        method: 'GET',
        originalUrl: '/api/v1/catalog/products/p1',
        headers: {},
      } as any);
      expect(trial1.status).toBe(200);
      expect(breaker.getState()).toBe('HALF_OPEN');
      expect(breaker.getSnapshot().consecutiveSuccesses).toBe(1);

      // Trial 2: Succeeds (halfOpenMaxTrials is 2)
      const trial2 = await proxyService.forward({
        method: 'GET',
        originalUrl: '/api/v1/catalog/products/p2',
        headers: {},
      } as any);
      expect(trial2.status).toBe(200);

      // Circuit MUST now be fully recovered to CLOSED!
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
      expect(breaker.isOpen()).toBe(false);
    });
  });
});
