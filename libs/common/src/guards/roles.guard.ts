import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@libs/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { USER_ROLE_HEADER } from '../middleware/correlation-id.middleware';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector: Reflector;

  constructor(reflector?: Reflector) {
    this.reflector = reflector ?? new Reflector();
  }

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<(UserRole | string)[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If route has no @Roles decorator, allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const rawRole =
      request.user?.role ??
      request.headers?.[USER_ROLE_HEADER] ??
      request.headers?.['x-user-role'];

    const userRole = Array.isArray(rawRole) ? rawRole[0] : rawRole;

    if (!userRole) {
      throw new ForbiddenException('Access denied: missing role');
    }

    const hasRole = requiredRoles.includes(userRole as any);
    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied: required role(s) [${requiredRoles.join(', ')}], caller has '${userRole}'`,
      );
    }

    return true;
  }
}
