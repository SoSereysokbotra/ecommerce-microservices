import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '@libs/common';
import { GuestCartStore } from './modules/cart/guest-cart.store';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly guestCarts: GuestCartStore,
  ) {}

  /** Liveness: the process is up. Must not touch the database. */
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'cart-service' };
  }

  /** Readiness: this instance can serve, which means the database answers. */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'not-ready',
        service: 'cart-service',
        reason: 'database unreachable',
      });
    }

    // Unlike the other services, readiness here also covers Redis: guest carts
    // are half of what this service does, and it cannot serve them without it.
    if (!(await this.guestCarts.ping())) {
      throw new ServiceUnavailableException({
        status: 'not-ready',
        service: 'cart-service',
        reason: 'redis unreachable',
      });
    }

    return { status: 'ready', service: 'cart-service' };
  }
}
