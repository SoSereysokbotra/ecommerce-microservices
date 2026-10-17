import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles, RolesGuard, UserRole } from '@libs/common';
import { ResilienceService } from './resilience.service';

@ApiTags('Admin Resilience')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/resilience')
export class ResilienceController {
  constructor(private readonly resilienceService: ResilienceService) {}

  @Get('circuits')
  getCircuitBreakers() {
    return this.resilienceService.getCircuitBreakers();
  }

  @Post('circuits/reset-all')
  resetAllCircuitBreakers() {
    return this.resilienceService.resetAllCircuitBreakers();
  }

  @Post('circuits/:serviceKey/reset')
  resetCircuitBreaker(@Param('serviceKey') serviceKey: string) {
    return this.resilienceService.resetCircuitBreaker(serviceKey);
  }

  @Get('dlq')
  getDlqStats() {
    return this.resilienceService.getDlqStats();
  }

  @Post('dlq/:queue/replay')
  replayDeadLetters(@Param('queue') queue: string, @Body() body?: { limit?: number }) {
    return this.resilienceService.replayDeadLetters(queue, body?.limit);
  }

  @Post('dlq/:queue/purge')
  purgeDeadLetters(@Param('queue') queue: string) {
    return this.resilienceService.purgeDeadLetters(queue);
  }
}
