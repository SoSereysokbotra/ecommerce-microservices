import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import {
  CORRELATION_ID_HEADER,
  TRACEPARENT_HEADER,
  createChildSpanContext,
  createTraceContext,
  getTraceContext,
  runWithTraceContext,
} from '@libs/common';

export interface RabbitMQModuleOptions {
  url: string;
  exchange?: string;
  queue?: string;
  /**
   * Routing keys this service's queue binds to. Defaults to `#` (everything),
   * which is convenient but means a service also receives the events it
   * publishes itself. Naming the keys you actually want is safer.
   */
  bindingKeys?: string[];
  /** Dead Letter Exchange name for quarantining poison messages. Defaults to 'commerce.dlx' */
  dlxExchange?: string;
  /** Max delivery attempts before quarantining into DLQ. Defaults to 3 */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds for retrying failed messages. Defaults to 1000ms */
  retryBackoffMs?: number;
}

export type RabbitMQHandler<T = unknown> = (message: T) => Promise<void> | void;

const RECONNECT_DELAY_MS = 3000;

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private readonly url: string;
  private readonly exchange: string;
  private readonly queue?: string;
  private readonly bindingKeys: string[];
  private readonly dlxExchange: string;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly handlers = new Map<string, RabbitMQHandler>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(options: RabbitMQModuleOptions) {
    this.url = options.url;
    this.exchange = options.exchange ?? 'commerce.events';
    this.queue = options.queue;
    this.bindingKeys = options.bindingKeys ?? ['#'];
    this.dlxExchange = options.dlxExchange ?? process.env.RABBITMQ_DLX_EXCHANGE ?? 'commerce.dlx';
    this.maxRetries = options.maxRetries ?? Number(process.env.RABBITMQ_MAX_RETRIES ?? 3);
    this.retryBackoffMs =
      options.retryBackoffMs ?? Number(process.env.RABBITMQ_RETRY_BACKOFF_MS ?? 1000);
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.disconnect();
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  getExchange(): string {
    return this.exchange;
  }

  getDlxExchange(): string {
    return this.dlxExchange;
  }

  getQueueName(): string | undefined {
    return this.queue;
  }

  private async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();

      // Main application topic exchange
      await this.channel.assertExchange(this.exchange, 'topic', { durable: true });

      // Dead Letter Exchange (DLX) for poison message quarantine
      await this.channel.assertExchange(this.dlxExchange, 'topic', { durable: true });

      if (this.queue) {
        const dlqQueue = `${this.queue}.dlq`;

        // 1. Declare and bind Dead Letter Queue (DLQ)
        await this.channel.assertQueue(dlqQueue, { durable: true });
        await this.channel.bindQueue(dlqQueue, this.dlxExchange, `${this.queue}.#`);
        await this.channel.bindQueue(dlqQueue, this.dlxExchange, dlqQueue);

        // 2. Declare main queue with DLX routing arguments (with safe fallback if existing queue differs)
        try {
          await this.channel.assertQueue(this.queue, {
            durable: true,
            arguments: {
              'x-dead-letter-exchange': this.dlxExchange,
              'x-dead-letter-routing-key': dlqQueue,
            },
          });
        } catch {
          // If queue already exists in broker without DLX arguments, recreate channel and assert durable
          this.channel = await this.connection.createChannel();
          await this.channel.assertQueue(this.queue, { durable: true });
        }

        // 3. Bind routing keys to main queue
        for (const key of this.bindingKeys) {
          await this.channel.bindQueue(this.queue, this.exchange, key);
        }
      }

      // Handle connection disconnects
      this.connection.on('close', () => this.handleDisconnect('connection closed'));
      this.connection.on('error', (error) => this.handleDisconnect(getErrorMessage(error)));

      this.logger.log(
        `Connected to RabbitMQ (${this.exchange}${this.queue ? `, queue ${this.queue}` : ''}; DLX: ${this.dlxExchange})`,
      );

      // Re-attach consumers after a reconnect
      for (const queue of this.handlers.keys()) {
        await this.consume(queue);
      }
    } catch (error) {
      this.channel = null;
      this.connection = null;
      this.logger.warn(
        `RabbitMQ unavailable (${getErrorMessage(error)}); retrying in ${RECONNECT_DELAY_MS}ms`,
      );
      this.scheduleReconnect();
    }
  }

  private handleDisconnect(reason: string): void {
    if (this.shuttingDown || this.channel === null) {
      return;
    }
    this.channel = null;
    this.connection = null;
    this.logger.warn(`RabbitMQ disconnected (${reason}); reconnecting`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // ignore shutdown errors
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }

  /**
   * Prepares payload and AMQP headers with distributed trace context (W3C traceparent & correlationId).
   */
  private preparePublishOptions(
    message: unknown,
    options?: amqp.Options.Publish,
  ): { payload: Buffer; publishOptions: amqp.Options.Publish; correlationId: string } {
    const activeCtx = getTraceContext();
    const msgObj =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : null;

    let traceCtx = activeCtx ? createChildSpanContext(activeCtx) : undefined;
    if (!traceCtx && msgObj && (msgObj.correlationId || msgObj.traceparent)) {
      traceCtx = createTraceContext({
        correlationId: msgObj.correlationId as string,
        traceparent: msgObj.traceparent as string,
        serviceName: process.env.SERVICE_NAME,
      });
    }

    const headers: Record<string, unknown> = { ...(options?.headers ?? {}) };
    if (traceCtx) {
      if (!headers[CORRELATION_ID_HEADER]) {
        headers[CORRELATION_ID_HEADER] = traceCtx.correlationId;
      }
      if (!headers[TRACEPARENT_HEADER]) {
        headers[TRACEPARENT_HEADER] = traceCtx.traceparent;
      }
    }

    let serialized = message;
    if (msgObj && traceCtx) {
      serialized = {
        ...msgObj,
        correlationId: msgObj.correlationId ?? traceCtx.correlationId,
        traceparent: msgObj.traceparent ?? traceCtx.traceparent,
      };
    }

    const payload = Buffer.from(JSON.stringify(serialized));
    const publishOptions: amqp.Options.Publish = {
      persistent: true,
      ...options,
      headers,
    };

    return {
      payload,
      publishOptions,
      correlationId: traceCtx?.correlationId ?? '-',
    };
  }

  /**
   * Fire-and-forget publish. Logs and returns when the broker is unreachable.
   */
  async publish(
    exchange: string = this.exchange,
    routingKey: string,
    message: unknown,
    options?: amqp.Options.Publish,
  ): Promise<void> {
    const { payload, publishOptions, correlationId } = this.preparePublishOptions(message, options);

    if (!this.channel) {
      this.logger.log(`[offline] Publish ${routingKey}: ${payload.toString()}`);
      return;
    }

    this.channel.publish(exchange, routingKey, payload, publishOptions);
    this.logger.debug(`Published ${routingKey} to ${exchange} [${correlationId}]`);
  }

  /**
   * Publish, or throw if the broker is unreachable.
   * Used by transactional outbox relays and critical sagas.
   */
  async publishOrThrow(
    routingKey: string,
    message: unknown,
    options?: amqp.Options.Publish,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error(`RabbitMQ is not connected; cannot publish ${routingKey}`);
    }

    const { payload, publishOptions, correlationId } = this.preparePublishOptions(message, options);
    const accepted = this.channel.publish(this.exchange, routingKey, payload, publishOptions);

    if (!accepted) {
      throw new Error(`RabbitMQ back-pressure; ${routingKey} not accepted`);
    }

    this.logger.debug(`Published ${routingKey} to ${this.exchange} [${correlationId}]`);
  }

  async subscribe(queue: string, handler: RabbitMQHandler): Promise<void> {
    this.handlers.set(queue, handler);

    if (this.channel) {
      await this.consume(queue);
    }
  }

  private async consume(queue: string): Promise<void> {
    if (!this.channel) {
      return;
    }

    const handler = this.handlers.get(queue);
    if (!handler) {
      return;
    }

    await this.channel.consume(queue, async (message) => {
      if (!message || !this.channel) {
        return;
      }

      const headers = (message.properties.headers ?? {}) as Record<string, unknown>;

      try {
        const parsed = JSON.parse(message.content.toString()) as Record<string, unknown>;

        const incomingTrace =
          (headers[TRACEPARENT_HEADER] as string) || (parsed.traceparent as string);
        const incomingCorr =
          (headers[CORRELATION_ID_HEADER] as string) || (parsed.correlationId as string);

        const consumerCtx = createTraceContext({
          traceparent: incomingTrace,
          correlationId: incomingCorr,
          serviceName: process.env.SERVICE_NAME,
        });

        await runWithTraceContext(consumerCtx, async () => {
          await handler({
            ...parsed,
            correlationId: parsed.correlationId ?? consumerCtx.correlationId,
            traceparent: parsed.traceparent ?? consumerCtx.traceparent,
            routingKey: message.fields.routingKey,
          });
        });

        this.channel.ack(message);
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        const retryHeader = headers['x-retry-count'];
        const currentAttempts =
          typeof retryHeader === 'number' ? retryHeader : Number(retryHeader ?? 0);

        if (currentAttempts < this.maxRetries) {
          // 1. Exponential Backoff Retry (e.g. 1s, 2s, 4s)
          const backoffMs = this.retryBackoffMs * Math.pow(2, currentAttempts);
          this.logger.warn(
            `[retry ${currentAttempts + 1}/${this.maxRetries}] Message failed on ${queue}; retrying in ${backoffMs}ms: ${errorMsg}`,
          );

          setTimeout(async () => {
            try {
              if (this.channel) {
                this.channel.publish(this.exchange, message.fields.routingKey, message.content, {
                  ...message.properties,
                  headers: {
                    ...headers,
                    'x-retry-count': currentAttempts + 1,
                    'x-last-error': errorMsg,
                    'x-last-attempt-at': new Date().toISOString(),
                  },
                });
              }
            } catch (republishErr) {
              this.logger.error(
                `Failed to publish retry message: ${getErrorMessage(republishErr)}`,
              );
            }
          }, backoffMs);

          this.channel.ack(message);
        } else {
          // 2. Maximum retries exceeded: POISON PILL QUARANTINE TO DLQ
          this.logger.error(
            `[poison-quarantine] Message on ${queue} exceeded max ${this.maxRetries} retries; routing to DLQ: ${errorMsg}`,
          );

          const dlqRoutingKey = `${queue}.dlq`;
          const quarantineHeaders = {
            ...headers,
            'x-quarantine-reason': 'MaxRetriesExceeded',
            'x-quarantine-error': errorMsg,
            'x-quarantine-at': new Date().toISOString(),
            'x-original-queue': queue,
            'x-original-routing-key': message.fields.routingKey,
            'x-total-attempts': currentAttempts + 1,
          };

          this.channel.publish(this.dlxExchange, dlqRoutingKey, message.content, {
            ...message.properties,
            persistent: true,
            headers: quarantineHeaders,
          });

          this.channel.ack(message);
        }
      }
    });
  }

  /**
   * Retrieves message counts and consumer depths for a queue and its DLQ.
   */
  async getQueueStats(queueName: string = this.queue ?? ''): Promise<{
    queue: string;
    messageCount: number;
    consumerCount: number;
    dlqQueue: string;
    dlqMessageCount: number;
  }> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not open');
    }
    const dlqQueue = `${queueName}.dlq`;

    const mainCheck = await this.channel.checkQueue(queueName);
    let dlqCheck = { messageCount: 0 };
    try {
      dlqCheck = await this.channel.checkQueue(dlqQueue);
    } catch {
      // DLQ might be empty or unasserted yet
    }

    return {
      queue: queueName,
      messageCount: mainCheck.messageCount,
      consumerCount: mainCheck.consumerCount,
      dlqQueue,
      dlqMessageCount: dlqCheck.messageCount,
    };
  }

  /**
   * Replays dead-lettered messages from the DLQ back to the main topic exchange.
   */
  async replayDeadLetters(options?: {
    queue?: string;
    limit?: number;
  }): Promise<{ replayed: number; errors: number }> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not open');
    }

    const targetQueue = options?.queue ?? this.queue;
    if (!targetQueue) {
      throw new Error('No queue specified for DLQ replay');
    }

    const dlqQueue = `${targetQueue}.dlq`;
    const limit = options?.limit ?? 50;
    let replayed = 0;
    let errors = 0;

    for (let i = 0; i < limit; i++) {
      const msg = await this.channel.get(dlqQueue, { noAck: false });
      if (!msg) {
        break; // No more messages in DLQ
      }

      try {
        const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
        const originalRoutingKey =
          (headers['x-original-routing-key'] as string) || msg.fields.routingKey;

        // Clean quarantine and retry headers before replay
        const cleanedHeaders = { ...headers };
        delete cleanedHeaders['x-retry-count'];
        delete cleanedHeaders['x-quarantine-reason'];
        delete cleanedHeaders['x-quarantine-error'];
        delete cleanedHeaders['x-quarantine-at'];

        this.channel.publish(this.exchange, originalRoutingKey, msg.content, {
          ...msg.properties,
          headers: {
            ...cleanedHeaders,
            'x-replayed-at': new Date().toISOString(),
          },
        });

        this.channel.ack(msg);
        replayed++;
      } catch (err) {
        this.logger.error(`Failed to replay dead letter message: ${getErrorMessage(err)}`);
        this.channel.nack(msg, false, true); // requeue in DLQ if redrive publish failed
        errors++;
      }
    }

    this.logger.log(`DLQ Replay complete for ${dlqQueue}: replayed ${replayed}, errors ${errors}`);
    return { replayed, errors };
  }

  /**
   * Purges all quarantined messages in the Dead Letter Queue.
   */
  async purgeDeadLetters(queueName: string = this.queue ?? ''): Promise<{ purged: number }> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not open');
    }
    const dlqQueue = `${queueName}.dlq`;
    const result = await this.channel.purgeQueue(dlqQueue);
    return { purged: result.messageCount };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
