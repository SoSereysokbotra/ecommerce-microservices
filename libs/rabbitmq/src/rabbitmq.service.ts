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

  private async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.exchange, 'topic', { durable: true });

      if (this.queue) {
        await this.channel.assertQueue(this.queue, { durable: true });
        for (const key of this.bindingKeys) {
          await this.channel.bindQueue(this.queue, this.exchange, key);
        }
      }

      // A dropped connection must not leave a stale channel behind: publishing
      // through one fails silently, which is exactly what the outbox exists to
      // prevent.
      this.connection.on('close', () => this.handleDisconnect('connection closed'));
      this.connection.on('error', (error) => this.handleDisconnect(getErrorMessage(error)));

      this.logger.log(
        `Connected to RabbitMQ (${this.exchange}${this.queue ? `, queue ${this.queue}` : ''})`,
      );

      // Re-attach consumers after a reconnect.
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
   * Injects active distributed trace context into AMQP headers and payload envelope.
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
   * Used by outbox relays and critical sagas. Injects distributed trace context.
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
      // The write buffer is full. Treat it as a failure so the row stays
      // unpublished and is retried, rather than assuming it got through.
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

      try {
        const parsed = JSON.parse(message.content.toString()) as Record<string, unknown>;
        const headers = (message.properties.headers ?? {}) as Record<string, unknown>;

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
        this.logger.error(`Failed to process message on ${queue}: ${getErrorMessage(error)}`);
        // requeue=false: a message that keeps failing would otherwise spin
        // forever. M18 adds a dead-letter queue so these are quarantined
        // instead of dropped.
        this.channel.nack(message, false, false);
      }
    });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
