import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY } from '@libs/common';
import { UserRole } from '@libs/shared-types';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(
    user?: { role?: string; id?: string },
    headers: Record<string, string | string[]> = {},
  ): ExecutionContext {
    const handler = () => {};
    const classRef = class {};

    return {
      getHandler: () => handler,
      getClass: () => classRef,
      switchToHttp: () => ({
        getRequest: () => ({
          user,
          headers,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should allow access when no roles are defined on the route', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    const context = createMockContext({ role: UserRole.CUSTOMER });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when caller role matches required role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.ADMIN]);

    const context = createMockContext({ role: UserRole.ADMIN });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when caller role matches one of multiple required roles', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.ADMIN, UserRole.STAFF]);

    const context = createMockContext({ role: UserRole.STAFF });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should extract role from x-user-role header if user object is not present', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.ADMIN]);

    const context = createMockContext(undefined, { 'x-user-role': UserRole.ADMIN });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should handle x-user-role header passed as an array', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.STAFF]);

    const context = createMockContext(undefined, { 'x-user-role': [UserRole.STAFF] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException if caller has insufficient role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.ADMIN]);

    const context = createMockContext({ role: UserRole.CUSTOMER });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(/Access denied: required role\(s\)/);
  });

  it('should throw ForbiddenException if caller has no role and no role header', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.ADMIN]);

    const context = createMockContext();
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow('Access denied: missing role');
  });
});
