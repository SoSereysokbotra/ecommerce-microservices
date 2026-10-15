import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RolesGuard, USER_ID_HEADER, USER_ROLE_HEADER, UserRole } from '@libs/common';
import { ROLES_KEY } from '@libs/common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '@libs/common/decorators/public.decorator';
import { IS_OPTIONAL_AUTH_KEY } from '@libs/common/decorators/optional-auth.decorator';
import { GatewayJwtGuard } from '../src/auth/gateway-jwt.guard';
import { ProxyService } from '../src/proxy/proxy.service';
import * as jwt from 'jsonwebtoken';

describe('M16 Security Perimeter & RBAC Matrix Audit', () => {
  const JWT_SECRET = 'matrix-test-secret-32-chars-long-123456';

  describe('1. Gateway Perimeter & Header Sanitization', () => {
    let proxyService: ProxyService;
    let configService: jest.Mocked<ConfigService>;
    let httpService: any;

    beforeEach(() => {
      configService = {
        get: jest.fn((key: string) => {
          if (key === 'catalogServiceUrl') return 'http://catalog-service:3002';
          if (key === 'usersServiceUrl') return 'http://users-service:3001';
          return undefined;
        }),
      } as any;

      httpService = {
        request: jest.fn().mockReturnValue({
          toPromise: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } }),
        }),
      };

      proxyService = new ProxyService(httpService, configService);
    });

    it('strips spoofed client headers (x-user-id, x-user-role, x-session-id) before forwarding', async () => {
      let forwardedHeaders: Record<string, string> = {};
      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async (config: any) => {
        forwardedHeaders = config.headers;
        return { status: 200, headers: {}, data: { ok: true } } as any;
      });

      const fakeReq: any = {
        method: 'GET',
        originalUrl: '/api/v1/catalog/products',
        headers: {
          'x-user-id': 'attacker-impersonating-admin',
          'x-user-role': 'admin',
          'x-session-id': 'hijacked-sid',
        },
      };

      await proxyService.forward(fakeReq);

      expect(forwardedHeaders[USER_ID_HEADER]).toBeUndefined();
      expect(forwardedHeaders[USER_ROLE_HEADER]).toBeUndefined();
      expect(forwardedHeaders['x-session-id']).toBeUndefined();
    });

    it('injects verified x-user-id, x-user-role, and x-session-id from authenticated request', async () => {
      let forwardedHeaders: Record<string, string> = {};
      jest.spyOn(proxyService as any, 'sendWithRetry').mockImplementation(async (config: any) => {
        forwardedHeaders = config.headers;
        return { status: 200, headers: {}, data: { ok: true } } as any;
      });

      const fakeReq: any = {
        method: 'POST',
        originalUrl: '/api/v1/users/admin-action',
        headers: {},
        user: {
          sub: 'verified-admin-id',
          role: UserRole.ADMIN,
          sid: 'valid-session-123',
        },
      };

      await proxyService.forward(fakeReq);

      expect(forwardedHeaders[USER_ID_HEADER]).toBe('verified-admin-id');
      expect(forwardedHeaders[USER_ROLE_HEADER]).toBe(UserRole.ADMIN);
      expect(forwardedHeaders['x-session-id']).toBe('valid-session-123');
    });
  });

  describe('2. Gateway JWT Authentication Guard', () => {
    let guard: GatewayJwtGuard;
    let reflector: Reflector;
    let configService: jest.Mocked<ConfigService>;

    beforeEach(() => {
      reflector = new Reflector();
      configService = {
        get: jest.fn((key: string) => {
          if (key === 'jwtSecret') return JWT_SECRET;
          return undefined;
        }),
      } as any;

      guard = new GatewayJwtGuard(reflector, configService);
      (guard as any).checkRedisSession = jest.fn().mockResolvedValue(true);
    });

    afterEach(async () => {
      await guard.onModuleDestroy();
    });

    function createMockContext(
      headers: Record<string, string>,
      isPublic = false,
      isOptional = false,
    ) {
      const request: any = { headers, cookies: {} };
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return isPublic;
        if (key === IS_OPTIONAL_AUTH_KEY) return isOptional;
        return undefined;
      });

      return {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
        request,
      } as unknown as ExecutionContext & { request: any };
    }

    it('rejects anonymous callers on protected routes with 401 Unauthorized', async () => {
      const ctx = createMockContext({}, false, false);
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('allows anonymous callers on @Public() routes', async () => {
      const ctx = createMockContext({}, true, false);
      const allowed = await guard.canActivate(ctx);
      expect(allowed).toBe(true);
    });

    it('allows anonymous callers on @OptionalAuth() routes', async () => {
      const ctx = createMockContext({}, false, true);
      const allowed = await guard.canActivate(ctx);
      expect(allowed).toBe(true);
    });

    it('authenticates valid Bearer token and attaches user payload', async () => {
      const token = jwt.sign({ sub: 'user-123', role: UserRole.CUSTOMER, sid: 's-1' }, JWT_SECRET);
      const ctx = createMockContext({ authorization: `Bearer ${token}` }, false, false);

      const allowed = await guard.canActivate(ctx);
      expect(allowed).toBe(true);
      expect(ctx.request.user.sub).toBe('user-123');
      expect(ctx.request.user.role).toBe(UserRole.CUSTOMER);
    });

    it('rejects expired or malformed token with 401 Unauthorized', async () => {
      const ctx = createMockContext({ authorization: 'Bearer invalid.jwt.token' }, false, false);
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('3. Multi-Role RBAC Authorization Matrix Verification', () => {
    let rolesGuard: RolesGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      rolesGuard = new RolesGuard(reflector);
    });

    function createRbacContext(
      role: UserRole | 'anonymous',
      requiredRoles?: (UserRole | string)[],
    ) {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);

      const request: any = {
        headers: {},
        user: role === 'anonymous' ? undefined : { id: 'test-user', sub: 'test-user', role },
      };

      if (role !== 'anonymous') {
        request.headers[USER_ROLE_HEADER] = role;
      }

      return {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;
    }

    const testMatrix: Array<{
      category: string;
      requiredRoles?: (UserRole | string)[];
      expected: Record<UserRole | 'anonymous', boolean>;
    }> = [
      {
        category: 'Public Routes (e.g. GET /catalog/products, POST /pricing/quote)',
        requiredRoles: undefined, // No @Roles metadata
        expected: {
          anonymous: true,
          [UserRole.CUSTOMER]: true,
          [UserRole.STAFF]: true,
          [UserRole.ADMIN]: true,
        },
      },
      {
        category:
          'Staff/Operations Routes (e.g. catalog/inventory/reviews/shipping/recommendations/orders ops)',
        requiredRoles: [UserRole.ADMIN, UserRole.STAFF],
        expected: {
          anonymous: false,
          [UserRole.CUSTOMER]: false,
          [UserRole.STAFF]: true,
          [UserRole.ADMIN]: true,
        },
      },
      {
        category:
          'Admin-Only Routes (e.g. /search/admin/recreate-index, /pricing/coupons, /users/:id/role)',
        requiredRoles: [UserRole.ADMIN],
        expected: {
          anonymous: false,
          [UserRole.CUSTOMER]: false,
          [UserRole.STAFF]: false,
          [UserRole.ADMIN]: true,
        },
      },
    ];

    testMatrix.forEach(({ category, requiredRoles, expected }) => {
      describe(category, () => {
        Object.entries(expected).forEach(([role, shouldAllow]) => {
          it(`${role.toUpperCase()} -> ${shouldAllow ? 'ALLOW (200 OK)' : 'DENY (403 Forbidden)'}`, () => {
            const ctx = createRbacContext(role as UserRole | 'anonymous', requiredRoles);

            if (shouldAllow) {
              expect(rolesGuard.canActivate(ctx)).toBe(true);
            } else {
              expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
            }
          });
        });
      });
    });
  });
});
