import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { RabbitMQModule } from '@libs/rabbitmq';
import { OutboxModule } from '@libs/outbox';
import { AppController } from './app.controller';
import { EventsModule } from './events/events.module';
import { paymentsConfig } from './config/payments.config';
import { typeOrmConfig } from './database/typeorm.config';
import { PaymentsModule } from './modules/payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [paymentsConfig] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => typeOrmConfig(config),
    }),
    RabbitMQModule.forRoot({
      url: process.env.RABBITMQ_URL ?? 'amqp://rabbitmq:5672',
      exchange: process.env.RABBITMQ_EXCHANGE ?? 'commerce.events',
      queue: process.env.RABBITMQ_QUEUE ?? 'payments-service',
      bindingKeys: ['payment.requested', 'payment.refund_requested'],
    }),
    OutboxModule.forRoot({ pollIntervalMs: 1000 }),
    PaymentsModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
