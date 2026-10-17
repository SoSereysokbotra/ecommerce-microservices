import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CircuitBreakerRegistry } from '../resilience/circuit-breaker';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000, // ceiling; per-request timeout set in ProxyService
      maxRedirects: 5,
    }),
  ],
  controllers: [ProxyController],
  providers: [ProxyService, CircuitBreakerRegistry],
  exports: [ProxyService, CircuitBreakerRegistry],
})
export class ProxyModule {}
