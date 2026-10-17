import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { CircuitBreaker, CircuitBreakerRegistry } from '../src/resilience/circuit-breaker';
import { ProxyService } from '../src/proxy/proxy.service';

describe('Phase 1: API Gateway Circuit Breaker Engine', () => {
  describe('CircuitBreaker State Machine', () => {
    let breaker: CircuitBreaker;

    beforeEach(() => {
      breaker = new CircuitBreaker('test-service', {
        failureThreshold: 3,
        recoveryTimeoutMs: 1000,
        halfOpenMaxTrials: 2,
      });
    });

    it('initializes in CLOSED state with 0 failures', () => {
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
    });

    it('remains in CLOSED state when failures are below threshold', () => {
      breaker.recordFailure(new Error('Connection reset'));
      breaker.recordFailure(new Error('Connection timeout'));

      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getSnapshot().consecutiveFailures).toBe(2);
    });

    it('resets consecutive failures count on success in CLOSED state', () => {
      breaker.recordFailure(new Error('Connection reset'));
      expect(breaker.getSnapshot().consecutiveFailures).toBe(1);

      breaker.recordSuccess();
      expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('trips to OPEN state when failure threshold is reached', () => {
      breaker.recordFailure(new Error('Err 1'));
      breaker.recordFailure(new Error('Err 2'));
      breaker.recordFailure(new Error('Err 3'));

      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.isOpen()).toBe(true);
      expect(breaker.getRetryAfterSeconds()).toBeGreaterThan(0);
    });

    it('transitions from OPEN to HALF_OPEN after recovery timeout has elapsed', async () => {
      breaker.recordFailure(new Error('Err 1'));
      breaker.recordFailure(new Error('Err 2'));
      breaker.recordFailure(new Error('Err 3'));
      expect(breaker.getState()).toBe('OPEN');

      // Wait for recovery timeout (1000ms)
      await new Promise((resolve) => setTimeout(resolve, 1050));

      expect(breaker.getState()).toBe('HALF_OPEN');
      expect(breaker.isOpen()).toBe(false);
    });

    it('immediately trips back to OPEN if a probe fails during HALF_OPEN', async () => {
      breaker.recordFailure(new Error('Err 1'));
      breaker.recordFailure(new Error('Err 2'));
      breaker.recordFailure(new Error('Err 3'));
      await new Promise((resolve) => setTimeout(resolve, 1050));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Probe fails
      breaker.recordFailure(new Error('Probe failed'));
      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.isOpen()).toBe(true);
    });

    it('recovers to CLOSED state after halfOpenMaxTrials consecutive successes in HALF_OPEN', async () => {
      breaker.recordFailure(new Error('Err 1'));
      breaker.recordFailure(new Error('Err 2'));
      breaker.recordFailure(new Error('Err 3'));
      await new Promise((resolve) => setTimeout(resolve, 1050));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Trial 1 success
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('HALF_OPEN');
      expect(breaker.getSnapshot().consecutiveSuccesses).toBe(1);

      // Trial 2 success (threshold is 2)
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
    });

    it('supports explicit administrative reset', () => {
      breaker.recordFailure(new Error('Err 1'));
      breaker.recordFailure(new Error('Err 2'));
      breaker.recordFailure(new Error('Err 3'));
      expect(breaker.isOpen()).toBe(true);

      breaker.reset();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.isOpen()).toBe(false);
    });
  });

  describe('CircuitBreakerRegistry', () => {
    let registry: CircuitBreakerRegistry;
    let configService: jest.Mocked<ConfigService>;

    beforeEach(() => {
      configService = {
        get: jest.fn((key: string) => {
          if (key === 'circuitBreakerFailureThreshold') return 4;
          if (key === 'circuitBreakerRecoveryTimeoutMs') return 5000;
          if (key === 'circuitBreakerHalfOpenTrials') return 2;
          return undefined;
        }),
      } as any;

      registry = new CircuitBreakerRegistry(configService);
    });

    it('creates and caches independent breakers per upstream service', () => {
      const catalogBreaker = registry.getBreaker('catalogServiceUrl');
      const recsBreaker = registry.getBreaker('recommendationsServiceUrl');

      expect(catalogBreaker).toBeDefined();
      expect(recsBreaker).toBeDefined();
      expect(catalogBreaker).not.toBe(recsBreaker);

      // Verify caching: calling getBreaker again returns the same instance
      expect(registry.getBreaker('catalogServiceUrl')).toBe(catalogBreaker);
    });

    it('isolates failures between services (outage in recommendations does not trip catalog)', () => {
      const catalogBreaker = registry.getBreaker('catalogServiceUrl');
      const recsBreaker = registry.getBreaker('recommendationsServiceUrl');

      // 4 failures on recommendations trips its breaker
      for (let i = 0; i < 4; i++) {
        recsBreaker.recordFailure(new Error('Recommendation service down'));
      }

      expect(recsBreaker.getState()).toBe('OPEN');
      expect(recsBreaker.isOpen()).toBe(true);

      // Catalog service remains healthy and CLOSED
      expect(catalogBreaker.getState()).toBe('CLOSED');
      expect(catalogBreaker.isOpen()).toBe(false);
    });

    it('returns snapshots of all registered circuit breakers', () => {
      registry.getBreaker('ordersServiceUrl');
      registry.getBreaker('paymentsServiceUrl');

      const snapshots = registry.getAllSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((s) => s.serviceKey)).toEqual(
        expect.arrayContaining(['ordersServiceUrl', 'paymentsServiceUrl']),
      );
    });

    it('resets all breakers simultaneously via resetAll()', () => {
      const b1 = registry.getBreaker('ordersServiceUrl');
      const b2 = registry.getBreaker('paymentsServiceUrl');

      for (let i = 0; i < 4; i++) {
        b1.recordFailure(new Error('err'));
        b2.recordFailure(new Error('err'));
      }
      expect(b1.isOpen()).toBe(true);
      expect(b2.isOpen()).toBe(true);

      registry.resetAll();

      expect(b1.isOpen()).toBe(false);
      expect(b2.isOpen()).toBe(false);
      expect(b1.getState()).toBe('CLOSED');
      expect(b2.getState()).toBe('CLOSED');
    });
  });

  describe('ProxyService Circuit Breaker Fast-Failing Integration', () => {
    let proxyService: ProxyService;
    let configService: jest.Mocked<ConfigService>;
    let httpService: any;
    let registry: CircuitBreakerRegistry;

    beforeEach(() => {
      configService = {
        get: jest.fn((key: string) => {
          if (key === 'catalogServiceUrl') return 'http://catalog-service:3002';
          if (key === 'recommendationsServiceUrl') return 'http://recommendations-service:3012';
          if (key === 'upstreamTimeoutMs') return 1000;
          if (key === 'upstreamRetries') return 0;
          if (key === 'circuitBreakerFailureThreshold') return 3;
          if (key === 'circuitBreakerRecoveryTimeoutMs') return 10000;
          return undefined;
        }),
      } as any;

      httpService = {
        request: jest.fn(),
      };

      registry = new CircuitBreakerRegistry(configService);
      proxyService = new ProxyService(httpService, configService, registry);
    });

    it('forwards requests normally and records success when circuit is CLOSED', async () => {
      jest.spyOn(proxyService as any, 'sendWithRetry').mockResolvedValue({
        status: 200,
        headers: {},
        data: [{ id: 'prod-1' }],
      });

      const fakeReq: any = {
        method: 'GET',
        originalUrl: '/api/v1/catalog/products',
        headers: {},
      };

      const res = await proxyService.forward(fakeReq);

      expect(res.status).toBe(200);
      expect(res.headers['x-circuit-breaker-status']).toBe('CLOSED');
      expect(registry.getBreaker('catalogServiceUrl').getState()).toBe('CLOSED');
    });

    it('trips the circuit breaker after consecutive upstream 500 errors', async () => {
      jest.spyOn(proxyService as any, 'sendWithRetry').mockResolvedValue({
        status: 500,
        headers: {},
        data: { error: 'Internal Server Error' },
      });

      const fakeReq: any = {
        method: 'GET',
        originalUrl: '/api/v1/recommendations/products/p1',
        headers: {},
      };

      // 3 consecutive 500 responses (threshold is 3)
      await proxyService.forward(fakeReq);
      await proxyService.forward(fakeReq);
      await proxyService.forward(fakeReq);

      expect(registry.getBreaker('recommendationsServiceUrl').getState()).toBe('OPEN');
    });

    it('fast-fails with 503 and does NOT hit the network when circuit is OPEN', async () => {
      const breaker = registry.getBreaker('recommendationsServiceUrl');
      breaker.recordFailure(new Error('Down 1'));
      breaker.recordFailure(new Error('Down 2'));
      breaker.recordFailure(new Error('Down 3'));
      expect(breaker.isOpen()).toBe(true);

      const sendWithRetrySpy = jest.spyOn(proxyService as any, 'sendWithRetry');

      const fakeReq: any = {
        method: 'GET',
        originalUrl: '/api/v1/recommendations/products/p1',
        headers: {},
        correlationId: 'test-corr-id',
      };

      await expect(proxyService.forward(fakeReq)).rejects.toThrow(HttpException);

      try {
        await proxyService.forward(fakeReq);
      } catch (err: any) {
        expect(err.getStatus()).toBe(503);
        const responseBody = err.getResponse();
        expect(responseBody.circuitStatus).toBe('OPEN');
        expect(responseBody.upstream).toBe('recommendationsServiceUrl');
        expect(responseBody.retryAfterSeconds).toBeGreaterThan(0);
      }

      // Assert that sendWithRetry was NEVER called because it fast-failed!
      expect(sendWithRetrySpy).not.toHaveBeenCalled();
    });
  });
});
