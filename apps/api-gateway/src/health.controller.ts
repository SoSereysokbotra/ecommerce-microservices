import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';

@ApiTags('health')
@Controller()
export class HealthController {
  /** Liveness: the process is up. Never touches a dependency. */
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'api-gateway' };
  }

  /**
   * Readiness: this instance can serve traffic.
   *
   * The gateway holds no state of its own, so readiness equals liveness here.
   * Deliberately does NOT check upstreams — a single unhealthy service must not
   * pull the whole gateway out of the load balancer.
   */
  @Public()
  @Get('ready')
  ready(): { status: string; service: string } {
    return { status: 'ready', service: 'api-gateway' };
  }
}
