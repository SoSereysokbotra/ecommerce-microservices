import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProxyModule } from '../proxy/proxy.module';
import { ResilienceService } from './resilience.service';
import { ResilienceController } from './resilience.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
    ProxyModule,
  ],
  controllers: [ResilienceController],
  providers: [ResilienceService],
  exports: [ResilienceService],
})
export class ResilienceModule {}
