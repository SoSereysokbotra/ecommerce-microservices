import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { PricingModule } from './modules/pricing/pricing.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { CurrencyModule } from './modules/currency/currency.module';
import { EventsModule } from './events/events.module';

/**
 * M8 shipped this service with **no** `RabbitMQModule`, `OutboxModule` or
 * `processed_events`, and the comment here explained why: a quote is a pure read
 * that changes no state, so there was nothing to make atomic with an event and
 * nothing to deduplicate on redelivery.
 *
 * M9 added coupons, and a redemption *is* state — it has to be given back when
 * the order holding it is cancelled, which arrives as an event over an
 * at-least-once bus. So the wiring is here now, at the milestone that needed it
 * rather than the one that guessed it might.
 *
 * The original note is kept below, because the reasoning is still the reason
 * this service was built the way it was.
 *
 * ---
 *
 * Note what is **not** here: no `RabbitMQModule`, no `OutboxModule`, no
 * `processed_events`. This service publishes nothing and consumes nothing.
 *
 * That is deliberate rather than unfinished. A quote is a pure read that
 * changes no state, so there is nothing to make atomic with an event and
 * nothing to deduplicate on redelivery — the two problems the outbox and the
 * idempotent consumer exist to solve. Five of the six services before this one
 * have that wiring, and pasting it in out of habit would add a queue nobody
 * publishes to and a relay polling an empty table forever.
 *
 * M9 will add it, because a coupon redemption *is* state and has to be released
 * when a saga compensates. That is the right time.
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
      queue: process.env.RABBITMQ_QUEUE ?? 'pricing-service',
      // Only how an order ended. Pricing takes no part in driving the saga.
      bindingKeys: ['order.confirmed', 'order.cancelled'],
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    PricingModule,
    CouponsModule,
    CurrencyModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
