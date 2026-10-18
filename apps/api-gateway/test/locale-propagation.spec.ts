import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { LOCALE_HEADER } from '@libs/common';
import { resolveLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../src/i18n/locale.resolver';
import { LocaleMiddleware } from '../src/i18n/locale.middleware';
import { ProxyService } from '../src/proxy/proxy.service';
import { CircuitBreakerRegistry } from '../src/resilience/circuit-breaker';
import { FallbackRegistry } from '../src/resilience/fallback';

describe('Milestone 20 Phase 2: Edge Locale Resolution & Inter-Service Propagation', () => {
  describe('LocaleResolver', () => {
    it('defines supported locales and default fallback locale', () => {
      expect(SUPPORTED_LOCALES).toEqual(['en', 'km']);
      expect(DEFAULT_LOCALE).toBe('en');
    });

    it('resolves locale from ?lang= query parameter', () => {
      const req = {
        query: { lang: 'km' },
        headers: {},
      } as unknown as Request;

      expect(resolveLocale(req)).toBe('km');
    });

    it('resolves locale from ?locale= query parameter', () => {
      const req = {
        query: { locale: 'km' },
        headers: {},
      } as unknown as Request;

      expect(resolveLocale(req)).toBe('km');
    });

    it('resolves locale from commerce_locale cookie', () => {
      const req = {
        query: {},
        cookies: { commerce_locale: 'km' },
        headers: {},
      } as unknown as Request;

      expect(resolveLocale(req)).toBe('km');
    });

    it('resolves locale from x-locale header', () => {
      const req = {
        query: {},
        headers: { [LOCALE_HEADER]: 'km' },
      } as unknown as Request;

      expect(resolveLocale(req)).toBe('km');
    });

    it('resolves locale from Accept-Language header (Khmer)', () => {
      const req = {
        query: {},
        headers: { 'accept-language': 'km-KH,km;q=0.9,en-US;q=0.8,en;q=0.7' },
      } as unknown as Request;

      expect(resolveLocale(req)).toBe('km');
    });

    it('resolves locale from Accept-Language header (English)', () => {
      const req = {
        query: {},
        headers: { 'accept-language': 'en-US,en;q=0.9' },
      } as unknown as Request;

      expect(resolveLocale(req)).toBe('en');
    });

    it('honors resolution precedence: query > cookie > header > accept-language', () => {
      // Query overrides cookie and header
      const reqQueryWins = {
        query: { lang: 'km' },
        cookies: { commerce_locale: 'en' },
        headers: { [LOCALE_HEADER]: 'en', 'accept-language': 'en-US' },
      } as unknown as Request;
      expect(resolveLocale(reqQueryWins)).toBe('km');

      // Cookie overrides header and accept-language
      const reqCookieWins = {
        query: {},
        cookies: { commerce_locale: 'km' },
        headers: { [LOCALE_HEADER]: 'en', 'accept-language': 'en-US' },
      } as unknown as Request;
      expect(resolveLocale(reqCookieWins)).toBe('km');

      // Header overrides accept-language
      const reqHeaderWins = {
        query: {},
        headers: { [LOCALE_HEADER]: 'km', 'accept-language': 'en-US' },
      } as unknown as Request;
      expect(resolveLocale(reqHeaderWins)).toBe('km');
    });

    it('falls back to default "en" for unsupported locales or empty requests', () => {
      const reqUnsupported = {
        query: { lang: 'fr' },
        headers: { 'accept-language': 'fr-FR,fr;q=0.9' },
      } as unknown as Request;
      expect(resolveLocale(reqUnsupported)).toBe('en');

      const reqEmpty = {
        query: {},
        headers: {},
      } as unknown as Request;
      expect(resolveLocale(reqEmpty)).toBe('en');
    });
  });

  describe('LocaleMiddleware', () => {
    let middleware: LocaleMiddleware;

    beforeEach(() => {
      middleware = new LocaleMiddleware();
    });

    it('attaches resolved locale to req.locale and sets x-locale response header', () => {
      const req = {
        query: { lang: 'km' },
        headers: {},
      } as unknown as Request;

      const setHeaderMock = jest.fn();
      const res = {
        setHeader: setHeaderMock,
      } as unknown as Response;

      const next = jest.fn();

      middleware.use(req, res, next);

      expect(req.locale).toBe('km');
      expect(setHeaderMock).toHaveBeenCalledWith(LOCALE_HEADER, 'km');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('ProxyService Downstream Propagation', () => {
    let proxyService: ProxyService;
    let configService: jest.Mocked<ConfigService>;
    let httpService: any;
    let circuitBreakerRegistry: CircuitBreakerRegistry;
    let fallbackRegistry: FallbackRegistry;

    beforeEach(() => {
      configService = {
        get: jest.fn((key: string) => {
          if (key === 'catalogServiceUrl') return 'http://catalog-service:3002';
          if (key === 'recommendationsServiceUrl') return 'http://recommendations-service:3012';
          if (key === 'upstreamTimeoutMs') return 1000;
          if (key === 'upstreamRetries') return 0;
          return undefined;
        }),
      } as any;

      httpService = {
        request: jest.fn(),
      };

      circuitBreakerRegistry = new CircuitBreakerRegistry(configService);
      fallbackRegistry = new FallbackRegistry();
      proxyService = new ProxyService(
        httpService,
        configService,
        circuitBreakerRegistry,
        fallbackRegistry,
      );
    });

    it('forwards x-locale header downstream and echoes it in gateway response', async () => {
      let forwardedHeaders: Record<string, string> = {};

      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async (cfg: any) => {
        forwardedHeaders = cfg.headers;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: [{ id: 'p1', name: 'កាហ្វេ' }],
        };
      });

      const req: any = {
        method: 'GET',
        originalUrl: '/api/v1/catalog/products',
        headers: {},
        locale: 'km',
        correlationId: 'i18n-corr-1',
      };

      const res = await proxyService.forward(req);

      expect(res.status).toBe(200);
      expect(forwardedHeaders[LOCALE_HEADER]).toBe('km');
      expect(res.headers[LOCALE_HEADER]).toBe('km');
    });

    it('resolves locale automatically if req.locale was not pre-populated', async () => {
      let forwardedHeaders: Record<string, string> = {};

      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async (cfg: any) => {
        forwardedHeaders = cfg.headers;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: [],
        };
      });

      const req: any = {
        method: 'GET',
        originalUrl: '/api/v1/catalog/products?lang=km',
        query: { lang: 'km' },
        headers: {},
        correlationId: 'i18n-corr-2',
      };

      const res = await proxyService.forward(req);

      expect(forwardedHeaders[LOCALE_HEADER]).toBe('km');
      expect(res.headers[LOCALE_HEADER]).toBe('km');
    });

    it('attaches x-locale header to degraded fallback responses', async () => {
      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async () => {
        return {
          status: 500,
          statusText: 'Internal Server Error',
          headers: {},
          data: { error: 'down' },
        };
      });

      const req: any = {
        method: 'GET',
        originalUrl: '/api/v1/recommendations/products/p1',
        headers: {},
        locale: 'km',
        correlationId: 'i18n-fallback-corr',
      };

      const res = await proxyService.forward(req);

      expect(res.headers[LOCALE_HEADER]).toBe('km');
      expect(res.data).toEqual({ items: [], total: 0 });
    });
  });
});
