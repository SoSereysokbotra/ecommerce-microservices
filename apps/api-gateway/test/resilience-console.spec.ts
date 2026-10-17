import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosResponse } from 'axios';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@libs/common';
import { ResilienceController } from '../src/resilience/resilience.controller';
import { ResilienceService } from '../src/resilience/resilience.service';
import { CircuitBreakerRegistry } from '../src/resilience/circuit-breaker';

// Mock amqplib before ResilienceService attempts to require it
const mockChannel = {
  get: jest.fn(),
  publish: jest.fn().mockReturnValue(true),
  ack: jest.fn(),
  purgeQueue: jest.fn().mockResolvedValue({ messageCount: 4 }),
  close: jest.fn().mockResolvedValue(undefined),
};

const mockConnection = {
  createChannel: jest.fn().mockResolvedValue(mockChannel),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock(
  'amqplib',
  () => ({
    connect: jest.fn().mockResolvedValue(mockConnection),
  }),
  { virtual: true },
);

describe('Phase 4: Resilience Console & DLQ Redrive Test Suite', () => {
  let resilienceService: ResilienceService;
  let resilienceController: ResilienceController;
  let circuitBreakerRegistry: CircuitBreakerRegistry;
  let httpService: HttpService;

  beforeEach(async () => {
    const mockHttpService = {
      get: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'rabbitmqUrl') return 'amqp://localhost:5672';
        if (key === 'rabbitmqApi') return 'http://localhost:15672';
        if (key === 'rabbitmqExchange') return 'commerce.events';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ResilienceController],
      providers: [
        ResilienceService,
        CircuitBreakerRegistry,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpService, useValue: mockHttpService },
      ],
    }).compile();

    resilienceService = module.get<ResilienceService>(ResilienceService);
    resilienceController = module.get<ResilienceController>(ResilienceController);
    circuitBreakerRegistry = module.get<CircuitBreakerRegistry>(CircuitBreakerRegistry);
    httpService = module.get<HttpService>(HttpService);

    jest.clearAllMocks();
  });

  describe('ResilienceController Security & RBAC Metadata', () => {
    it('restricts all endpoints on ResilienceController strictly to ADMIN role', () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[]>(ROLES_KEY, ResilienceController);
      expect(roles).toBeDefined();
      expect(roles).toContain(UserRole.ADMIN);
      expect(roles).not.toContain(UserRole.CUSTOMER);
      expect(roles).not.toContain(UserRole.STAFF);
    });
  });

  describe('Circuit Breaker Telemetry & Administrative Controls', () => {
    it('returns snapshots of all registered circuit breakers', () => {
      // Access two breakers to register them
      const b1 = circuitBreakerRegistry.getBreaker('catalogServiceUrl');
      const b2 = circuitBreakerRegistry.getBreaker('ordersServiceUrl');
      b1.recordFailure(new Error('Downstream error'));

      const snapshots = resilienceController.getCircuitBreakers();

      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      const catalogSnap = snapshots.find((s) => s.serviceKey === 'catalogServiceUrl');
      expect(catalogSnap).toBeDefined();
      expect(catalogSnap?.consecutiveFailures).toBe(1);
      expect(catalogSnap?.state).toBe('CLOSED');
    });

    it('resets a tripped circuit breaker back to CLOSED via administrator command', () => {
      const breaker = circuitBreakerRegistry.getBreaker('recommendationsServiceUrl');
      // Trip the breaker with failures
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(new Error('Connection timeout'));
      }
      expect(breaker.getState()).toBe('OPEN');

      const result = resilienceController.resetCircuitBreaker('recommendationsServiceUrl');

      expect(result.state).toBe('CLOSED');
      expect(result.consecutiveFailures).toBe(0);
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('resets all circuit breakers simultaneously via reset-all command', () => {
      const b1 = circuitBreakerRegistry.getBreaker('reviewsServiceUrl');
      const b2 = circuitBreakerRegistry.getBreaker('searchServiceUrl');
      for (let i = 0; i < 5; i++) {
        b1.recordFailure(new Error('fail'));
        b2.recordFailure(new Error('fail'));
      }
      expect(b1.getState()).toBe('OPEN');
      expect(b2.getState()).toBe('OPEN');

      const res = resilienceController.resetAllCircuitBreakers();

      expect(res.ok).toBe(true);
      expect(res.resetCount).toBeGreaterThanOrEqual(2);
      expect(b1.getState()).toBe('CLOSED');
      expect(b2.getState()).toBe('CLOSED');
    });
  });

  describe('RabbitMQ Dead Letter Queue (DLQ) Telemetry', () => {
    it('queries RabbitMQ management API and correctly parses depths and statuses', async () => {
      const mockQueuesData = [
        { name: 'orders-service', messages: 15 },
        { name: 'orders-service.dlq', messages: 2 },
        { name: 'payments-service', messages: 0 },
        { name: 'payments-service.dlq', messages: 0 },
      ];

      const axiosResponse: AxiosResponse = {
        data: mockQueuesData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} } as AxiosResponse['config'],
      };

      jest.spyOn(httpService, 'get').mockReturnValue(of(axiosResponse));

      const stats = await resilienceController.getDlqStats();

      expect(stats.connected).toBe(true);
      expect(stats.totalQuarantined).toBe(2);

      const ordersQueue = stats.queues.find((q) => q.queue === 'orders-service');
      expect(ordersQueue).toBeDefined();
      expect(ordersQueue?.mainDepth).toBe(15);
      expect(ordersQueue?.dlqDepth).toBe(2);
      expect(ordersQueue?.status).toBe('HAS_POISON_MSGS');

      const paymentsQueue = stats.queues.find((q) => q.queue === 'payments-service');
      expect(paymentsQueue).toBeDefined();
      expect(paymentsQueue?.mainDepth).toBe(0);
      expect(paymentsQueue?.dlqDepth).toBe(0);
      expect(paymentsQueue?.status).toBe('HEALTHY');
    });

    it('falls back gracefully to STANDBY if RabbitMQ Management API is unavailable', async () => {
      jest.spyOn(httpService, 'get').mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

      const stats = await resilienceController.getDlqStats();

      expect(stats.connected).toBe(false);
      expect(stats.totalQuarantined).toBe(0);
      expect(stats.queues.length).toBeGreaterThan(0);
      expect(stats.queues[0].status).toBe('STANDBY');
    });
  });

  describe('DLQ Redrive & Purge Actions', () => {
    it('replays dead letters back to main exchange with cleaned headers and stamps x-replayed-at', async () => {
      const poisonMsg = {
        fields: { routingKey: 'order.dispatched' },
        properties: {
          headers: {
            'x-retry-count': 3,
            'x-quarantine-reason': 'MaxRetriesExceeded',
            'x-quarantine-error': 'ServiceUnavailable',
            'x-original-routing-key': 'order.confirmed',
            'x-correlation-id': 'corr-resilience-dlq-1',
          },
        },
        content: Buffer.from(JSON.stringify({ orderId: 'ord-dlq-999' })),
      };

      mockChannel.get.mockResolvedValueOnce(poisonMsg).mockResolvedValueOnce(null);

      const res = await resilienceController.replayDeadLetters('orders-service', { limit: 10 });

      expect(res.ok).toBe(true);
      expect(res.replayed).toBe(1);
      expect(res.queue).toBe('orders-service');
      expect(res.dlqQueue).toBe('orders-service.dlq');

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'commerce.events',
        'order.confirmed',
        poisonMsg.content,
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-correlation-id': 'corr-resilience-dlq-1',
            'x-replayed-at': expect.any(String),
          }),
        }),
      );

      // Verify poisoned headers were stripped before replay
      const publishedHeaders = mockChannel.publish.mock.calls[0][3].headers;
      expect(publishedHeaders['x-retry-count']).toBeUndefined();
      expect(publishedHeaders['x-quarantine-reason']).toBeUndefined();
      expect(publishedHeaders['x-quarantine-error']).toBeUndefined();

      expect(mockChannel.ack).toHaveBeenCalledWith(poisonMsg);
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('purges dead letter queue and closes channel/connection cleanly', async () => {
      const res = await resilienceController.purgeDeadLetters('orders-service');

      expect(res.ok).toBe(true);
      expect(res.purged).toBe(4);
      expect(res.dlqQueue).toBe('orders-service.dlq');
      expect(mockChannel.purgeQueue).toHaveBeenCalledWith('orders-service.dlq');
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });
});
