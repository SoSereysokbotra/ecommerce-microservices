import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from '@libs/common/decorators/public.decorator';
import { IS_OPTIONAL_AUTH_KEY } from '@libs/common/decorators/optional-auth.decorator';
import { JwtPayload } from '@libs/shared-types';

@Injectable()
export class GatewayJwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const isOptional = this.reflector.getAllAndOverride<boolean>(IS_OPTIONAL_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request.headers.authorization);

    if (!token) {
      // Optional routes serve anonymous callers; the upstream sees no
      // x-user-id and treats the request as a guest.
      if (isOptional) {
        return true;
      }
      throw new UnauthorizedException('Missing authentication token');
    }

    try {
      const secret = this.configService.get<string>('jwtSecret');
      if (!secret) {
        // Boot-time validation should have caught this; never verify with a default.
        throw new Error('JWT_SECRET is not configured');
      }
      const payload = jwt.verify(token, secret) as JwtPayload;
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(authorization?: string): string | null {
    const [type, token] = authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : null;
  }
}
