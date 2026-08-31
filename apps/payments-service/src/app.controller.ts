import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';

@ApiTags('health')
@Controller()
export class AppController {
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'payments-service' };
  }

  /** Stateless in M2 — no database to check, so readiness equals liveness. */
  @Public()
  @Get('ready')
  ready(): { status: string; service: string } {
    return { status: 'ready', service: 'payments-service' };
  }
}
