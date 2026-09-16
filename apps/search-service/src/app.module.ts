import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { AppController } from './app.controller';
import { SearchModule } from './modules/search/search.module';

/**
 * search-service — the ninth service, and the first with **no database**.
 *
 * Every other backend service imports `TypeOrmModule` and `OutboxModule` here.
 * This one imports neither, on purpose: it owns a read model in OpenSearch
 * that is built only by consuming catalog's `product.*` / `category.*` events
 * and can be deleted and rebuilt from them. There is no `processed_events`
 * table because none is needed — OpenSearch's external versioning makes every
 * write idempotent and ordering-safe on its own (docs/M12_SEARCH_PLAN.md §4).
 *
 * The queue and its bindings are declared from the scaffold, before the
 * consumer exists (step 3), so that events published in the meantime wait in
 * the queue rather than being dropped on the exchange floor.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RabbitMQModule.forRoot({
      url: process.env.RABBITMQ_URL ?? 'amqp://rabbitmq:5672',
      exchange: process.env.RABBITMQ_EXCHANGE ?? 'commerce.events',
      queue: process.env.RABBITMQ_QUEUE ?? 'search-service',
      bindingKeys: ['product.*', 'category.*'],
    }),
    SearchModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
