import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CircuitBreakerRegistry, CircuitBreakerSnapshot } from './circuit-breaker';
import * as path from 'path';

export interface QueueStatus {
  queue: string;
  mainDepth: number;
  dlqQueue: string;
  dlqDepth: number;
  status: 'HEALTHY' | 'HAS_POISON_MSGS' | 'STANDBY';
}

export interface DlqStatsResponse {
  connected: boolean;
  totalQuarantined: number;
  queues: QueueStatus[];
}

const KNOWN_QUEUES = [
  'users-service',
  'catalog-service',
  'inventory-service',
  'orders-service',
  'payments-service',
  'cart-service',
  'pricing-service',
  'shipping-service',
  'search-service',
  'reviews-service',
  'recommendations-service',
];

let amqpLib: any;
function getAmqpLib() {
  if (amqpLib) return amqpLib;
  try {
    amqpLib = require('amqplib');
  } catch {
    try {
      amqpLib = require(path.resolve(__dirname, '../../../../libs/rabbitmq/node_modules/amqplib'));
    } catch {
      try {
        amqpLib = require(path.resolve(__dirname, '../../../libs/rabbitmq/node_modules/amqplib'));
      } catch {
        amqpLib = null;
      }
    }
  }
  return amqpLib;
}

@Injectable()
export class ResilienceService {
  private readonly logger = new Logger(ResilienceService.name);
  private readonly rabbitmqUrl: string;
  private readonly rabbitmqApi: string;
  private readonly mainExchange: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreakerRegistry: CircuitBreakerRegistry,
    private readonly httpService: HttpService,
  ) {
    this.rabbitmqUrl =
      this.configService.get<string>('rabbitmqUrl') ??
      process.env.RABBITMQ_URL ??
      'amqp://localhost:5672';
    this.rabbitmqApi =
      this.configService.get<string>('rabbitmqApi') ??
      process.env.RABBITMQ_API ??
      'http://localhost:15672';
    this.mainExchange =
      this.configService.get<string>('rabbitmqExchange') ??
      process.env.RABBITMQ_EXCHANGE ??
      'commerce.events';
  }

  // --- Circuit Breaker Telemetry -----------------------------------------

  getCircuitBreakers(): CircuitBreakerSnapshot[] {
    return this.circuitBreakerRegistry.getAllSnapshots();
  }

  resetCircuitBreaker(serviceKey: string): CircuitBreakerSnapshot {
    const breaker = this.circuitBreakerRegistry.getBreaker(serviceKey);
    breaker.reset();
    this.logger.log(`Circuit breaker for '${serviceKey}' reset to CLOSED by administrator`);
    return breaker.getSnapshot();
  }

  resetAllCircuitBreakers(): { ok: boolean; resetCount: number } {
    this.circuitBreakerRegistry.resetAll();
    const count = this.circuitBreakerRegistry.getAllSnapshots().length;
    this.logger.log(`All ${count} circuit breakers reset to CLOSED by administrator`);
    return { ok: true, resetCount: count };
  }

  // --- RabbitMQ Dead Letter Queue (DLQ) Management -----------------------

  async getDlqStats(): Promise<DlqStatsResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.rabbitmqApi}/api/queues`, {
          auth: { username: 'guest', password: 'guest' },
          timeout: 3000,
        }),
      );

      const allQueues: any[] = response.data ?? [];
      const queueMap = new Map<string, any>(allQueues.map((q) => [q.name, q]));

      let totalQuarantined = 0;
      const queues: QueueStatus[] = KNOWN_QUEUES.map((name) => {
        const main = queueMap.get(name);
        const dlq = queueMap.get(`${name}.dlq`);

        const mainDepth = main?.messages ?? 0;
        const dlqDepth = dlq?.messages ?? 0;
        totalQuarantined += dlqDepth;

        return {
          queue: name,
          mainDepth,
          dlqQueue: `${name}.dlq`,
          dlqDepth,
          status: dlqDepth > 0 ? 'HAS_POISON_MSGS' : 'HEALTHY',
        };
      });

      return {
        connected: true,
        totalQuarantined,
        queues,
      };
    } catch {
      // RabbitMQ Management API unreachable or not yet booted
      return {
        connected: false,
        totalQuarantined: 0,
        queues: KNOWN_QUEUES.map((name) => ({
          queue: name,
          mainDepth: 0,
          dlqQueue: `${name}.dlq`,
          dlqDepth: 0,
          status: 'STANDBY',
        })),
      };
    }
  }

  async replayDeadLetters(
    targetQueue: string,
    limit = 50,
  ): Promise<{ ok: boolean; replayed: number; queue: string; dlqQueue: string }> {
    const dlqQueue = targetQueue.endsWith('.dlq') ? targetQueue : `${targetQueue}.dlq`;
    const amqp = getAmqpLib();

    if (!amqp) {
      throw new Error('amqplib client is not available in current runtime environment');
    }

    const connection = await amqp.connect(this.rabbitmqUrl);
    const channel = await connection.createChannel();

    let replayed = 0;
    try {
      for (let i = 0; i < limit; i++) {
        const msg = await channel.get(dlqQueue, { noAck: false });
        if (!msg) break;

        const headers = msg.properties.headers || {};
        const originalRoutingKey =
          headers['x-original-routing-key'] || msg.fields.routingKey || '#';

        const cleanedHeaders = { ...headers };
        delete cleanedHeaders['x-retry-count'];
        delete cleanedHeaders['x-quarantine-reason'];
        delete cleanedHeaders['x-quarantine-error'];
        delete cleanedHeaders['x-quarantine-at'];

        channel.publish(this.mainExchange, originalRoutingKey, msg.content, {
          ...msg.properties,
          headers: {
            ...cleanedHeaders,
            'x-replayed-at': new Date().toISOString(),
          },
        });

        channel.ack(msg);
        replayed++;
      }

      this.logger.log(
        `DLQ Replay: Replayed ${replayed} quarantined messages from ${dlqQueue} into ${this.mainExchange}`,
      );
      return { ok: true, replayed, queue: targetQueue, dlqQueue };
    } finally {
      await channel.close().catch(() => {});
      await connection.close().catch(() => {});
    }
  }

  async purgeDeadLetters(
    targetQueue: string,
  ): Promise<{ ok: boolean; purged: number; dlqQueue: string }> {
    const dlqQueue = targetQueue.endsWith('.dlq') ? targetQueue : `${targetQueue}.dlq`;
    const amqp = getAmqpLib();

    if (!amqp) {
      throw new Error('amqplib client is not available in current runtime environment');
    }

    const connection = await amqp.connect(this.rabbitmqUrl);
    const channel = await connection.createChannel();

    try {
      const result = await channel.purgeQueue(dlqQueue);
      this.logger.log(`DLQ Purge: Purged ${result.messageCount} messages from ${dlqQueue}`);
      return { ok: true, purged: result.messageCount, dlqQueue };
    } finally {
      await channel.close().catch(() => {});
      await connection.close().catch(() => {});
    }
  }
}
