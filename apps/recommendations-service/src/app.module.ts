import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { EventsModule } from './events/events.module';

/**
 * recommendations-service — the eleventh service, per M14 plan §5 (Option A).
 *
 * Accumulating read model derived from `order.confirmed` facts.
 * Postgres stores the symmetric co-purchase graph and `processed_events`
 * for transactional deduplication (M14 plan §4).
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
      queue: process.env.RABBITMQ_QUEUE ?? 'recommendations-service',
      bindingKeys: ['order.confirmed'],
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    RecommendationsModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
