import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { EventsModule } from './events/events.module';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { StockModule } from './modules/stock/stock.module';

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
      queue: process.env.RABBITMQ_QUEUE ?? 'inventory-service',
      // Bind only what this service reacts to, so it does not receive the
      // events it publishes itself.
      bindingKeys: ['order.created', 'inventory.commit_requested', 'inventory.release_requested'],
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    StockModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
