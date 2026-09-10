import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { ShippingModule } from './modules/shipping/shipping.module';
import { EventsModule } from './events/events.module';

/**
 * shipping-service — the eighth service, and the first thing in this project
 * that models something outliving the request that created it.
 *
 * The events wiring arrived at step 7, which is the commit that needed it —
 * the same rule M8 and M9 followed. Unlike cart-service and pricing-service,
 * which took the outbox before they had anything to publish and said so, both
 * halves are used here from the start: `order.confirmed` creates a shipment,
 * and the lifecycle publishes `shipment.dispatched` / `shipment.delivered`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => typeOrmConfig(config),
    }),
    RabbitMQModule.forRoot({
      url: process.env.RABBITMQ_URL ?? 'amqp://rabbitmq:5672',
      exchange: process.env.RABBITMQ_EXCHANGE ?? 'commerce.events',
      queue: process.env.RABBITMQ_QUEUE ?? 'shipping-service',
      // Only the success terminal state. `order.cancelled` is deliberately not
      // bound: a cancelled order never reached CONFIRMED, so it has no shipment
      // to withdraw, and subscribing in order to do nothing would imply there
      // was a compensation here. See ShipmentsService.
      bindingKeys: ['order.confirmed'],
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    ShippingModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
