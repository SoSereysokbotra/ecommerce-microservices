import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CorrelationIdMiddleware } from '@libs/common';
import { AppController } from './app.controller';
import { ChargesModule } from './modules/charges/charges.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ChargesModule],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
