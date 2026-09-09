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
    return { status: 'ok', service: 'shipping-service' };
  }

  /**
   * Readiness: this instance can serve, which means the database answers.
   *
   * Postgres only. Zones, rates and shipments are the whole of this service's
   * state and it calls nobody synchronously — a rate is computed from its own
   * tables, which is what lets pricing-service treat it as one more read.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      // Shaped as { message, error } rather than a custom payload: the shared
      // HttpExceptionFilter reads only those two keys off an exception body, so
      // any other field is silently dropped and the caller sees a bare
      // "Service Unavailable Exception" with no clue which dependency failed.
      throw new ServiceUnavailableException({
        message: 'shipping-service is not ready: database unreachable',
        error: 'Service Unavailable',
      });
    }

    return { status: 'ready', service: 'shipping-service' };
  }
}
