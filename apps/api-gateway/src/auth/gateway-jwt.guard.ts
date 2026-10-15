import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { IS_PUBLIC_KEY } from '@libs/common/decorators/public.decorator';
import { IS_OPTIONAL_AUTH_KEY } from '@libs/common/decorators/optional-auth.decorator';
import { JwtPayload } from '@libs/shared-types';

@Injectable()
export class GatewayJwtGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(GatewayJwtGuard.name);
  private readonly redis: Redis;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    const redisUrl =
      this.configService.get<string>('redisUrl') ?? process.env.REDIS_URL ?? 'redis://redis:6379';

    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });

    this.redis.on('error', (err) => {
      this.logger.warn(`Redis connection warning: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      this.redis.disconnect();
    } catch (_) {}
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
    const token = this.extractToken(request);

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

      // Fast-path sub-millisecond Redis session check (<0.5ms)
      if (payload.sid) {
        const isSessionActive = await this.checkRedisSession(payload.sid);
        if (!isSessionActive) {
          throw new UnauthorizedException('Session has been revoked or expired');
        }
      }

      request.user = payload;
      return true;
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: any): string | null {
    // 1. Prioritize secure httpOnly cookie
    if (request.cookies && request.cookies['commerce.accessToken']) {
      return request.cookies['commerce.accessToken'];
    }

    // 2. Fall back to Authorization: Bearer <token>
    const authorization = request.headers?.authorization;
    if (authorization) {
      const [type, token] = authorization.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }

    return null;
  }

  private async checkRedisSession(sessionId: string): Promise<boolean> {
    try {
      const status = await this.redis.get(`session:${sessionId}`);
      return status === 'active';
    } catch (err: any) {
      this.logger.warn(`Redis session check error: ${err.message}`);
      // If Redis is unreachable, allow valid signed JWT to proceed rather than failing closed
      // during temporary cache glitch.
      return true;
    }
  }
}
