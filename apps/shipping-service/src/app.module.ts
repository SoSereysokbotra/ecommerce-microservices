import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@libs/common';
import { AppController } from './app.controller';
import { databaseConfig } from './config/database.config';
import { typeOrmConfig } from './database/typeorm.config';
import { ShippingModule } from './modules/shipping/shipping.module';

/**
 * shipping-service — the eighth service, and the first thing in this project
 * that models something outliving the request that created it.
 *
 * Note what is **not** here yet: no `RabbitMQModule`, no `OutboxModule`. This is
 * the scaffold commit, and neither has anything to do until the shipment table
 * exists — an `OutboxModule` registered now would start a relay polling a table
 * no migration has created, and a queue binding would deliver `order.confirmed`
 * to a consumer that cannot yet write a shipment.
 *
 * They arrive at step 7 of `docs/M10_SHIPPING_PLAN.md` §13, which is the
 * milestone that needs them, following the same rule M8 and M9 followed: wiring
 * arrives when there is a reason for it, not in case there is one later.
 *
 * The entities for both are nevertheless already registered in
 * `typeorm.config.ts` — see the note there. Forgetting them is the mistake this
 * project has already made once, and registering an entity costs nothing.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => typeOrmConfig(config),
    }),
    ShippingModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
