import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';

export interface RabbitMQModuleOptions {
  url: string;
  exchange?: string;
  queue?: string;
}

export type RabbitMQHandler<T = unknown> = (message: T) => Promise<void> | void;

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private readonly url: string;
  private readonly exchange: string;
  private readonly queue?: string;
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly handlers = new Map<string, RabbitMQHandler>();

  constructor(options: RabbitMQModuleOptions) {
    this.url = options.url;
    this.exchange = options.exchange ?? 'saas.events';
    this.queue = options.queue;
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.exchange, 'topic', { durable: true });

      if (this.queue) {
        await this.channel.assertQueue(this.queue, { durable: true });
        await this.channel.bindQueue(this.queue, this.exchange, '#');
      }

      this.logger.log(`Connected to RabbitMQ (${this.exchange})`);
    } catch (error) {
      this.logger.warn(
        `RabbitMQ unavailable (${getErrorMessage(error)}); events will be logged only`,
      );
    }
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
        this.channel.nack(message, false, false);
      }
    });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
