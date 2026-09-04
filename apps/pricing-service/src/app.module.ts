import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { PricingModule } from './modules/pricing/pricing.module';

/**
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
    PricingModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
