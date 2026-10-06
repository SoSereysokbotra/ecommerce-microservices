import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '@libs/common';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Liveness: the process is up. Must not touch the database. */
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'recommendations-service' };
  }

  /**
   * Readiness: this instance can serve, which means the database answers.
   *
   * Postgres only. Per M14 plan §5 (Option A).
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        message: 'recommendations-service is not ready: database unreachable',
        error: 'Service Unavailable',
      });
    }

    return { status: 'ready', service: 'recommendations-service' };
  }
}
