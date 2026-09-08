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
    // Configurable because the defaults are a production posture, and the
    // Playwright suite legitimately exceeds them: ~14 tests each doing catalog
    // reads, auth, cart writes and order polling comfortably passes 100
    // requests a minute from one address. When it did, the gateway returned 429
    // and a *different* test failed each run — once as a 400 from pricing,
    // because a helper fed the 429 body's `undefined` id into a quote. Hours
    // went into chasing those before the rate limiter was the answer.
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.RATE_LIMIT_TTL_MS ?? 60_000),
        limit: Number(process.env.RATE_LIMIT_MAX ?? 100),
      },
    ]),
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
