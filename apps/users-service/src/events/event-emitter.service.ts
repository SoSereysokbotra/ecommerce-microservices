import { Injectable, Logger } from '@nestjs/common';
import { RabbitMQService } from '@libs/rabbitmq';

@Injectable()
export class EventEmitterService {
  private readonly logger = new Logger(EventEmitterService.name);

  constructor(private readonly rabbitmqService: RabbitMQService) {}

  async emit(routingKey: string, payload: unknown): Promise<void> {
    this.logger.log(`Emitting event ${routingKey}`);
    await this.rabbitmqService.publish(undefined, routingKey, payload);
  }
}
