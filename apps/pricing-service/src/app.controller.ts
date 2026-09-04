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
    return { status: 'ok', service: 'pricing-service' };
  }

  /**
   * Readiness: this instance can serve, which means the database answers.
   *
   * Only Postgres, unlike cart-service, which also pings Redis. Tax rules and
   * promotions are the only state a quote needs, and catalog being briefly
   * unreachable makes individual quotes fail rather than making this instance
   * unfit to serve — pulling it out of the load balancer for that would take
   * the whole service down every time one dependency hiccuped.
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
        message: 'pricing-service is not ready: database unreachable',
        error: 'Service Unavailable',
      });
    }

    return { status: 'ready', service: 'pricing-service' };
  }
}
