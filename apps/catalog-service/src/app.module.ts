import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { AdminModule } from './modules/admin/admin.module';

/**
 * M12 gave this service an outbox — the last backend service to get one.
 *
 * Catalog **publishes and consumes nothing else**: `RabbitMQModule` is
 * configured with no `queue`, so it asserts the exchange and binds nothing.
 * The relay publishes `product.*` and `category.*` for search-service to build
 * its index from, and that is the whole of catalog's involvement with the bus.
 * A queue here would receive events nobody handles.
 *
 * `AdminModule` (step 5) is the write side's half of a search reindex:
 * `POST /catalog/admin/republish` re-announces everything at its current
 * version. The write side owns replay — see docs/M12_SEARCH_PLAN.md §4.
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
      // No queue: publish-only. See the class note.
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    ProductsModule,
    CategoriesModule,
    AdminModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
