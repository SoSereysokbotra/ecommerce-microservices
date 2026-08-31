import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CorrelationIdMiddleware } from '@libs/common';
import servicesConfig from './config/services.config';
import { GatewayJwtGuard } from './auth/gateway-jwt.guard';
import { HealthController } from './health.controller';
import { ProxyModule } from './proxy/proxy.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [servicesConfig] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ProxyModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: GatewayJwtGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs before the guards so every log line, including auth failures,
    // carries the id.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
