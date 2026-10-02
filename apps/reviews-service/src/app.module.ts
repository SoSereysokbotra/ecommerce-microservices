import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { EventsModule } from './events/events.module';

/**
 * reviews-service — the tenth service, and the one that shows what M12's
 * read model is not.
 *
 * search-service deliberately has no database: its documents are a projection
 * and can be thrown away. A review is the opposite — written by a request,
 * owned by nobody else, impossible to rebuild from any event. So this service
 * has Postgres, an outbox and `processed_events`, exactly as shipping does.
 *
 * It consumes `order.confirmed` to learn who may review what, and publishes
 * `product.rating_changed` so search can carry the average. Both halves are
 * used from the first commit.
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
      queue: process.env.RABBITMQ_QUEUE ?? 'reviews-service',
      // Only the success terminal state. A cancelled order never granted the
      // right to review, so there is nothing to withdraw — the same argument
      // shipping-service makes for not binding `order.cancelled`.
      bindingKeys: ['order.confirmed'],
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    ReviewsModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
