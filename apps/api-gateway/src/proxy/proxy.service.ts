import { HttpService } from '@nestjs/axios';
import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CORRELATION_ID_HEADER,
  LOCALE_HEADER,
  TRACEPARENT_HEADER,
  USER_ID_HEADER,
  USER_ROLE_HEADER,
  SpanKind,
  SpanStatusCode,
  startTraceSpan,
} from '@libs/common';
import { AxiosError, AxiosResponse } from 'axios';
import { Request } from 'express';
import { firstValueFrom } from 'rxjs';
import { CircuitBreakerRegistry, CircuitState } from '../resilience/circuit-breaker';
import { FallbackRegistry } from '../resilience/fallback';
import { resolveLocale } from '../i18n/locale.resolver';

type AuthenticatedRequest = Request & {
  user?: { sub?: string; role?: string };
  correlationId?: string;
  traceparent?: string;
  locale?: string;
  /** Present only for routes registered with a raw body parser. */
  rawBody?: Buffer;
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
  [/^\/api\/v1\/recommendations(\/|$)/, 'recommendationsServiceUrl'],
];

/** Retrying a non-idempotent verb risks duplicating the write. */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly circuitBreakerRegistry: CircuitBreakerRegistry;
  private readonly fallbackRegistry: FallbackRegistry;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    circuitBreakerRegistry?: CircuitBreakerRegistry,
    fallbackRegistry?: FallbackRegistry,
  ) {
    this.circuitBreakerRegistry =
      circuitBreakerRegistry ?? new CircuitBreakerRegistry(this.configService);
    this.fallbackRegistry = fallbackRegistry ?? new FallbackRegistry();
  }

  getCircuitBreakerRegistry(): CircuitBreakerRegistry {
    return this.circuitBreakerRegistry;
  }

  getFallbackRegistry(): FallbackRegistry {
    return this.fallbackRegistry;
  }

  resolveRoute(path: string): { url: string; configKey: string } {
    const normalized = path.startsWith('/') ? path : `/${path}`;

    for (const [pattern, configKey] of ROUTE_TABLE) {
      if (pattern.test(normalized)) {
        const url = this.configService.get<string>(configKey);
        if (!url) {
          throw new NotFoundException(`No URL configured for ${configKey}`);
        }
        return { url, configKey };
      }
    }

    throw new NotFoundException(`No upstream service configured for path: ${path}`);
  }

  resolveBaseUrl(path: string): string {
    return this.resolveRoute(path).url;
  }

  async forward(request: AuthenticatedRequest): Promise<AxiosResponse> {
    const path = this.rewritePath(request.originalUrl);
    const { url: baseUrl, configKey } = this.resolveRoute(path);
    const targetUrl = `${baseUrl.replace(/\/$/, '')}${path}`;
    const breaker = this.circuitBreakerRegistry.getBreaker(configKey);

    const locale = request.locale ?? resolveLocale(request);

    // Fast-fail or gracefully degrade if the circuit breaker is OPEN
    if (breaker.isOpen()) {
      const retryAfter = breaker.getRetryAfterSeconds();

      // Non-critical read routes return safe empty projection rather than failing the client
      const fallback = this.fallbackRegistry.getFallback(
        request.method,
        path,
        `circuit_open_${configKey}`,
      );

      if (fallback) {
        this.logger.warn(
          `Degraded: Circuit breaker is OPEN for '${configKey}'; returning fallback for ${request.method} ${path} [${request.correlationId}]`,
        );
        fallback.headers['x-circuit-breaker-status'] = 'OPEN';
        fallback.headers['retry-after'] = String(retryAfter);
        fallback.headers[LOCALE_HEADER] = locale;
        return fallback;
      }

      this.logger.warn(
        `Fast-fail: Circuit breaker is OPEN for upstream '${configKey}' [${request.correlationId}]`,
      );
      throw new HttpException(
        {
          statusCode: 503,
          error: 'Service Unavailable',
          message: `The upstream service '${configKey}' is temporarily unavailable (circuit open). Please retry in ${retryAfter}s.`,
          upstream: configKey,
          circuitStatus: 'OPEN',
          retryAfterSeconds: retryAfter,
          correlationId: request.correlationId,
        },
        503,
      );
    }

    const headers = { ...request.headers };
    delete headers.host;
    delete headers['content-length'];
    headers[CORRELATION_ID_HEADER] = request.correlationId ?? '';
    const clientSpan = startTraceSpan(`HTTP ${request.method} ${configKey}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': request.method,
        'http.url': targetUrl,
        'upstream.service': configKey,
        correlation_id: request.correlationId ?? '',
      },
    });

    headers[TRACEPARENT_HEADER] = clientSpan.traceparent;
    headers[LOCALE_HEADER] = locale;

    // Forward the identity the guard already verified. Strip anything the
    // caller sent under these names first — otherwise a client could simply
    // claim to be another user.
    delete headers[USER_ID_HEADER];
    delete headers[USER_ROLE_HEADER];
    delete headers['x-session-id'];
    if (request.user?.sub) {
      headers[USER_ID_HEADER] = request.user.sub;
      headers[USER_ROLE_HEADER] = request.user.role ?? '';
      if ((request.user as any).sid) {
        headers['x-session-id'] = (request.user as any).sid;
      }
    }

    const timeout = this.configService.get<number>('upstreamTimeoutMs') ?? 5000;
    const maxRetries = RETRYABLE_METHODS.has(request.method)
      ? (this.configService.get<number>('upstreamRetries') ?? 2)
      : 0;

    try {
      const response = await this.sendWithRetry(
        {
          method: request.method,
          url: targetUrl,
          // Forward the untouched bytes when we captured them, so a provider
          // signature over the body still verifies downstream.
          headers,
          data: request.rawBody ?? request.body,
          params: request.query,
          timeout,
          validateStatus: () => true,
        },
        maxRetries,
        request.correlationId,
      );

      clientSpan.setAttribute('http.status_code', response.status);
      if (response.status >= 500) {
        clientSpan.setStatus(SpanStatusCode.ERROR, `HTTP ${response.status}`);
      } else {
        clientSpan.setStatus(SpanStatusCode.OK);
      }
      clientSpan.end();

      // Server error (5xx) is treated as an upstream failure for circuit breaker tracking
      if (response.status >= 500) {
        breaker.recordFailure(new Error(`Upstream returned HTTP ${response.status}`));

        const fallback = this.fallbackRegistry.getFallback(
          request.method,
          path,
          `upstream_status_${response.status}`,
        );
        if (fallback) {
          this.logger.warn(
            `Degraded: Upstream '${configKey}' returned ${response.status}; returning fallback for ${request.method} ${path} [${request.correlationId}]`,
          );
          fallback.headers['x-circuit-breaker-status'] = breaker.getState();
          fallback.headers[LOCALE_HEADER] = locale;
          return fallback;
        }
      } else {
        breaker.recordSuccess();
      }

      response.headers = response.headers ?? {};
      response.headers['x-circuit-breaker-status'] = breaker.getState();
      response.headers[LOCALE_HEADER] = locale;
      return response;
    } catch (error) {
      clientSpan.recordException(error);
      clientSpan.end();

      breaker.recordFailure(error);

      const fallback = this.fallbackRegistry.getFallback(
        request.method,
        path,
        'upstream_transport_failure',
      );
      if (fallback) {
        this.logger.warn(
          `Degraded: Upstream '${configKey}' unreachable; returning fallback for ${request.method} ${path} [${request.correlationId}]`,
        );
        fallback.headers['x-circuit-breaker-status'] = breaker.getState();
        fallback.headers[LOCALE_HEADER] = locale;
        return fallback;
      }

      throw this.toGatewayError(error, targetUrl, request.correlationId, breaker.getState());
    }
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
  private toGatewayError(
    error: unknown,
    url: string,
    correlationId?: string,
    circuitStatus: CircuitState = 'CLOSED',
  ): HttpException {
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
        circuitStatus,
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
