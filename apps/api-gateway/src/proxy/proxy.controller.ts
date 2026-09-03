import { All, Controller, Get, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OptionalAuth, Public } from '@libs/common';
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

  /**
   * Anonymous browsing.
   *
   * A shopper must be able to see products and their availability before
   * creating an account — requiring a token to view a catalogue would be a
   * strange shop. Deliberately GET-only: creating or editing a product falls
   * through to the authenticated handler below.
   *
   * Declaration order matters. Express matches routes in registration order and
   * Nest registers them in declaration order, so this must precede the `@All`
   * block or every GET would be caught by it and require a token.
   */
  @Public()
  @Get(['catalog', 'catalog/*', 'inventory/stock', 'inventory/stock/*'])
  async proxyPublicReads(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.sendProxy(request, response);
  }

  /**
   * Carts work signed in or not, so this must precede the guarded `@All` below
   * — Nest registers routes in declaration order. Without it a guest gets 401
   * and can never build a cart at all.
   */
  @OptionalAuth()
  @All(['cart', 'cart/*'])
  async proxyCart(@Req() request: Request, @Res() response: Response): Promise<void> {
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
