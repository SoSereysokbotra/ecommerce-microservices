import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { OpenSearchClient } from './modules/search/opensearch.client';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly opensearch: OpenSearchClient) {}

  /** Liveness: the process is up. Must not touch OpenSearch. */
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'search-service' };
  }

  /**
   * Readiness: this instance can serve, which means the cluster answers, is
   * not red, and the `products` index exists.
   *
   * OpenSearch only — the one service whose readiness does not mean "Postgres
   * answers". RabbitMQ is deliberately not checked, as nowhere else: a broker
   * outage delays the projection but does not stop search from serving what
   * it already has, and the client reconnects on its own.
   *
   * The index check is what lets a boot that raced the JVM recover: the
   * bootstrap in `OpenSearchClient.onModuleInit` logs and moves on when the
   * cluster is not up yet, and this probe repeats it until it succeeds.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    let reason: string;
    try {
      const status = await this.opensearch.clusterStatus();
      if (status !== 'red') {
        await this.opensearch.ensureIndex();
        return { status: 'ready', service: 'search-service' };
      }
      reason = 'cluster is red';
    } catch {
      reason = 'opensearch unreachable';
    }

    // Shaped as { message, error }: the shared HttpExceptionFilter reads only
    // those two keys off an exception body, so any other field is dropped and
    // the caller sees a bare "Service Unavailable" with no clue which
    // dependency failed.
    throw new ServiceUnavailableException({
      message: `search-service is not ready: ${reason}`,
      error: 'Service Unavailable',
    });
  }
}
