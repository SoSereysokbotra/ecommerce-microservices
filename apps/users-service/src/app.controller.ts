import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '@libs/common';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Liveness: the process is running. Must not touch the database — a database
   * blip should not cause the orchestrator to kill an otherwise healthy process.
   */
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'users-service' };
  }

  /**
   * Readiness: this instance can actually serve requests, which for this service
   * means the database is reachable. Compose and Kubernetes gate traffic on it.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'not-ready',
        service: 'users-service',
        reason: 'database unreachable',
      });
    }

    return { status: 'ready', service: 'users-service' };
  }
}
