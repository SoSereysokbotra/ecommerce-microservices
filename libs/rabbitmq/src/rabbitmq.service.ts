import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';

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
   * Fire-and-forget publish. Logs and returns when the broker is unreachable.
   *
   * Only safe for events nobody depends on. Anything that must not be lost goes
   * through the outbox, which uses `publishOrThrow`.
   */
  async publish(
    exchange: string = this.exchange,
    routingKey: string,
    message: unknown,
  ): Promise<void> {
    const payload = Buffer.from(JSON.stringify(message));

    if (!this.channel) {
      this.logger.log(`[offline] Publish ${routingKey}: ${payload.toString()}`);
      return;
    }

    this.channel.publish(exchange, routingKey, payload, { persistent: true });
    this.logger.debug(`Published ${routingKey} to ${exchange}`);
  }

  /**
   * Publish, or throw if the broker is unreachable.
   *
   * The outbox relay must use this. If a failed publish looked like a success
   * the relay would mark the row sent and the event would be lost forever —
   * the precise failure the outbox pattern exists to make impossible.
   */
  async publishOrThrow(routingKey: string, message: unknown): Promise<void> {
    if (!this.channel) {
      throw new Error(`RabbitMQ is not connected; cannot publish ${routingKey}`);
    }

    const payload = Buffer.from(JSON.stringify(message));
    const accepted = this.channel.publish(this.exchange, routingKey, payload, {
      persistent: true,
    });

    if (!accepted) {
      // The write buffer is full. Treat it as a failure so the row stays
      // unpublished and is retried, rather than assuming it got through.
      throw new Error(`RabbitMQ back-pressure; ${routingKey} not accepted`);
    }

    this.logger.debug(`Published ${routingKey} to ${this.exchange}`);
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
        await handler({
          ...parsed,
          routingKey: message.fields.routingKey,
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
