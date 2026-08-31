import { All, Controller, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { Request, Response } from 'express';
import { ProxyService } from './proxy.service';

@ApiExcludeController()
@Controller()
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  /** Login and registration cannot require a token. */
  @Public()
  @All(['auth', 'auth/*'])
  async proxyAuth(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.sendProxy(request, response);
  }

  /**
   * Stripe cannot present our JWT, so the webhook route is public. It is
   * authenticated by signature verification inside payments-service instead.
   */
  @Public()
  @All('payments/webhook')
  async proxyPaymentWebhook(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.sendProxy(request, response);
  }

  @All([
    'users',
    'users/*',
    'catalog',
    'catalog/*',
    'inventory',
    'inventory/*',
    'orders',
    'orders/*',
    'payments',
    'payments/*',
    'cart',
    'cart/*',
    'pricing',
    'pricing/*',
    'shipping',
    'shipping/*',
    'search',
    'search/*',
    'reviews',
    'reviews/*',
  ])
  async proxyProtected(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.sendProxy(request, response);
  }

  private async sendProxy(request: Request, response: Response): Promise<void> {
    const upstream = await this.proxyService.forward(request);

    response.status(upstream.status);
    Object.entries(upstream.headers).forEach(([key, value]) => {
      if (value !== undefined && key.toLowerCase() !== 'transfer-encoding') {
        response.setHeader(key, value as string | string[]);
      }
    });
    response.send(upstream.data);
  }
}
