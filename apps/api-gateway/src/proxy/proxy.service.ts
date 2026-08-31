import { HttpService } from '@nestjs/axios';
import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CORRELATION_ID_HEADER, USER_ID_HEADER, USER_ROLE_HEADER } from '@libs/common';
import { AxiosError, AxiosResponse } from 'axios';
import { Request } from 'express';
import { firstValueFrom } from 'rxjs';

type AuthenticatedRequest = Request & {
  user?: { sub?: string; role?: string };
  correlationId?: string;
};

/** Route prefix -> config key holding that service's base URL. */
const ROUTE_TABLE: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/v1\/(auth|users)(\/|$)/, 'usersServiceUrl'],
  [/^\/api\/v1\/catalog(\/|$)/, 'catalogServiceUrl'],
  [/^\/api\/v1\/inventory(\/|$)/, 'inventoryServiceUrl'],
  [/^\/api\/v1\/orders(\/|$)/, 'ordersServiceUrl'],
  [/^\/api\/v1\/payments(\/|$)/, 'paymentsServiceUrl'],
  [/^\/api\/v1\/cart(\/|$)/, 'cartServiceUrl'],
  [/^\/api\/v1\/pricing(\/|$)/, 'pricingServiceUrl'],
  [/^\/api\/v1\/shipping(\/|$)/, 'shippingServiceUrl'],
  [/^\/api\/v1\/search(\/|$)/, 'searchServiceUrl'],
  [/^\/api\/v1\/reviews(\/|$)/, 'reviewsServiceUrl'],
];

/** Retrying a non-idempotent verb risks duplicating the write. */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  resolveBaseUrl(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;

    for (const [pattern, configKey] of ROUTE_TABLE) {
      if (pattern.test(normalized)) {
        const url = this.configService.get<string>(configKey);
        if (!url) {
          throw new NotFoundException(`No URL configured for ${configKey}`);
        }
        return url;
      }
    }

    throw new NotFoundException(`No upstream service configured for path: ${path}`);
  }

  async forward(request: AuthenticatedRequest): Promise<AxiosResponse> {
    const path = this.rewritePath(request.originalUrl);
    const baseUrl = this.resolveBaseUrl(path);
    const targetUrl = `${baseUrl.replace(/\/$/, '')}${path}`;

    const headers = { ...request.headers };
    delete headers.host;
    delete headers['content-length'];
    headers[CORRELATION_ID_HEADER] = request.correlationId ?? '';

    // Forward the identity the guard already verified. Strip anything the
    // caller sent under these names first — otherwise a client could simply
    // claim to be another user.
    delete headers[USER_ID_HEADER];
    delete headers[USER_ROLE_HEADER];
    if (request.user?.sub) {
      headers[USER_ID_HEADER] = request.user.sub;
      headers[USER_ROLE_HEADER] = request.user.role ?? '';
    }

    const timeout = this.configService.get<number>('upstreamTimeoutMs') ?? 5000;
    const maxRetries = RETRYABLE_METHODS.has(request.method)
      ? (this.configService.get<number>('upstreamRetries') ?? 2)
      : 0;

    return this.sendWithRetry(
      {
        method: request.method,
        url: targetUrl,
        headers,
        data: request.body,
        params: request.query,
        timeout,
        validateStatus: () => true,
      },
      maxRetries,
      request.correlationId,
    );
  }

  /**
   * Retries only transport failures — a refused connection or a timeout. An HTTP
   * response, including a 500, is the upstream's answer and is passed through.
   */
  private async sendWithRetry(
    config: Parameters<HttpService['request']>[0],
    maxRetries: number,
    correlationId?: string,
  ): Promise<AxiosResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await firstValueFrom(this.httpService.request(config));
      } catch (error) {
        lastError = error;

        if (!this.isRetryable(error) || attempt === maxRetries) {
          break;
        }

        // Exponential backoff with jitter, so simultaneous callers do not
        // retry in lockstep and hammer a recovering service.
        const backoff = 100 * 2 ** attempt;
        const delay = backoff / 2 + Math.random() * (backoff / 2);
        this.logger.warn(
          `Upstream ${config.url} failed (attempt ${attempt + 1}/${maxRetries + 1}); ` +
            `retrying in ${Math.round(delay)}ms [${correlationId}]`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw this.toGatewayError(lastError, config.url ?? 'unknown', correlationId);
  }

  private isRetryable(error: unknown): boolean {
    const code = (error as AxiosError)?.code;
    return (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED' ||
      code === 'EAI_AGAIN' ||
      // A stopped container is removed from Docker's DNS, so a restarting
      // upstream surfaces as ENOTFOUND rather than a refused connection.
      code === 'ENOTFOUND'
    );
  }

  /**
   * An unreachable upstream is a 503, not an unhandled 500. The old gateway let
   * ECONNREFUSED escape as a raw stack trace, which told the caller nothing.
   */
  private toGatewayError(error: unknown, url: string, correlationId?: string): HttpException {
    const code = (error as AxiosError)?.code;
    const isTimeout = code === 'ETIMEDOUT' || code === 'ECONNABORTED';

    this.logger.error(`Upstream ${url} unreachable (${code ?? 'unknown'}) [${correlationId}]`);

    return new HttpException(
      {
        statusCode: isTimeout ? 504 : 503,
        error: isTimeout ? 'Gateway Timeout' : 'Service Unavailable',
        message: isTimeout
          ? 'The upstream service did not respond in time. Please try again.'
          : 'The upstream service is temporarily unavailable. Please try again.',
        correlationId,
      },
      isTimeout ? 504 : 503,
    );
  }

  private rewritePath(originalUrl: string): string {
    // Drop the query string: it is forwarded separately as axios `params`, and
    // leaving it on the URL too would duplicate every parameter upstream.
    const [pathname] = originalUrl.split('?');
    return pathname;
  }
}
