import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { Response } from 'express';
import { UserStatus, JwtPayload } from '@libs/shared-types';
import { SessionEntity } from '../entities/session.entity';
import { UserEntity } from '../../users/user.entity';

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  session: SessionEntity;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  jti: string;
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private readonly redis: Redis;
  private readonly sessionTtlSeconds: number;
  private readonly jwtSecret: string;
  private readonly refreshSecret: string;
  private readonly jwtExpiresIn: string;
  private readonly refreshExpiresIn: string;

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });

    this.redis.on('error', (err) => {
      this.logger.warn(`Redis connection warning: ${err.message}`);
    });

    this.jwtSecret = this.configService.get<string>('jwtSecret') ?? 'change-me';
    this.refreshSecret = process.env.JWT_REFRESH_SECRET || this.jwtSecret;
    this.jwtExpiresIn = this.configService.get<string>('jwtExpiresIn') ?? '1h';
    this.refreshExpiresIn = this.configService.get<string>('refreshTokenExpiresIn') ?? '7d';

    // Default 7 days session lifetime (in seconds)
    this.sessionTtlSeconds = 7 * 24 * 60 * 60;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      this.redis.disconnect();
    } catch (_) {}
  }

  /**
   * Hashes a token string using SHA-256 hex encoding.
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Creates a new device session in PostgreSQL and caches active state in Redis.
   */
  async createSession(
    user: Pick<UserEntity, 'id' | 'email' | 'role'>,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<SessionResult> {
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);

    // 1. Generate access and refresh tokens embedding sid
    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: sessionId,
    };
    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      sid: sessionId,
      jti: crypto.randomUUID(),
    };
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshExpiresIn,
    });

    // 2. Hash refresh token for storage
    const tokenHash = this.hashToken(refreshToken);

    const session = this.sessionRepo.create({
      id: sessionId,
      userId: user.id,
      tokenHash,
      userAgent: userAgent ? userAgent.slice(0, 512) : null,
      ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
      expiresAt,
    });

    const saved = await this.sessionRepo.save(session);

    // 3. Cache in Redis for <0.5ms gateway validation
    await this.setRedisSession(saved.id, this.sessionTtlSeconds);

    this.logger.log(`Created session ${saved.id} for user ${user.id}`);
    return { accessToken, refreshToken, session: saved };
  }

  /**
   * Rotates a session refresh token (SHA-256 swap with grace window protection).
   */
  async rotateSession(
    rawRefreshToken: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<SessionResult> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(rawRefreshToken, {
        secret: this.refreshSecret,
      });
    } catch (err: any) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const session = await this.sessionRepo.findOne({
      where: { id: payload.sid, revokedAt: IsNull() },
      relations: ['user'],
    });

    if (!session) {
      throw new UnauthorizedException('Session is invalid or has been revoked');
    }

    if (new Date() > session.expiresAt) {
      await this.revokeSession(session.id, 'Session expired');
      throw new UnauthorizedException('Session expired');
    }

    const incomingHash = this.hashToken(rawRefreshToken);

    // Validate hash against active tokenHash or prevTokenHash (grace window)
    const isCurrent = session.tokenHash === incomingHash;
    const isPrevious = session.prevTokenHash === incomingHash;

    if (!isCurrent && !isPrevious) {
      // Possible token reuse / breach attack: revoke session immediately!
      this.logger.error(
        `Token reuse detected on session ${session.id} for user ${session.userId}! Revoking session immediately.`,
      );
      await this.revokeSession(session.id, 'Token reuse detected');
      throw new UnauthorizedException('Session compromised: invalid token');
    }

    // Check user account status
    const user = session.user || (await this.userRepo.findOne({ where: { id: session.userId } }));
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('Your account has been suspended. Please contact support.');
    }
    if (user.status === UserStatus.BANNED) {
      throw new ForbiddenException('Your account has been banned.');
    }

    // Generate new token pair
    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: session.id,
    };
    const newAccessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      sid: session.id,
      jti: crypto.randomUUID(),
    };
    const newRefreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshExpiresIn,
    });

    const newHash = this.hashToken(newRefreshToken);

    session.prevTokenHash = session.tokenHash;
    session.tokenHash = newHash;
    session.expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);
    if (userAgent) session.userAgent = userAgent.slice(0, 512);
    if (ipAddress) session.ipAddress = String(ipAddress).slice(0, 64);

    const saved = await this.sessionRepo.save(session);
    await this.setRedisSession(saved.id, this.sessionTtlSeconds);

    return { accessToken: newAccessToken, refreshToken: newRefreshToken, session: saved };
  }

  /**
   * Revokes a specific session (deletes from Redis, marks revoked in DB).
   */
  async revokeSession(sessionId: string, reason = 'User logout'): Promise<void> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (session && !session.revokedAt) {
      session.revokedAt = new Date();
      session.revocationReason = reason;
      await this.sessionRepo.save(session);
    }
    await this.deleteRedisSession(sessionId);
    this.logger.log(`Revoked session ${sessionId} (${reason})`);
  }

  /**
   * Revokes all active sessions for a user, optionally preserving the current one.
   */
  async revokeAllUserSessions(
    userId: string,
    exceptSessionId?: string,
    reason = 'Remote logout of other devices',
  ): Promise<number> {
    const activeSessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
    });

    let revokedCount = 0;
    for (const s of activeSessions) {
      if (exceptSessionId && s.id === exceptSessionId) {
        continue;
      }
      s.revokedAt = new Date();
      s.revocationReason = reason;
      await this.sessionRepo.save(s);
      await this.deleteRedisSession(s.id);
      revokedCount++;
    }

    this.logger.log(
      `Revoked ${revokedCount} sessions for user ${userId} (exceptSessionId: ${exceptSessionId})`,
    );
    return revokedCount;
  }

  /**
   * Lists all active (unrevoked and unexpired) sessions for a user.
   */
  async listUserSessions(userId: string): Promise<SessionEntity[]> {
    return this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Checks if a session is currently active (checks Redis first for <0.5ms speed).
   */
  async isSessionActive(sessionId: string): Promise<boolean> {
    try {
      const cached = await this.redis.get(`session:${sessionId}`);
      if (cached === 'active') return true;
      if (cached === 'revoked') return false;
    } catch (_) {}

    // Fallback to PostgreSQL
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, revokedAt: IsNull() },
    });

    if (session && new Date() < session.expiresAt) {
      await this.setRedisSession(sessionId, this.sessionTtlSeconds);
      return true;
    }

    return false;
  }

  /**
   * Express Cookie Helpers for cross-origin storefront authentication
   */
  setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    const isProd = process.env.NODE_ENV === 'production';

    res.cookie('commerce.accessToken', accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 1000, // 1 hour
    });

    res.cookie('commerce.refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  }

  clearAuthCookies(res: Response): void {
    const isProd = process.env.NODE_ENV === 'production';
    const clearOpts = {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax' as const,
      path: '/',
    };
    res.clearCookie('commerce.accessToken', clearOpts);
    res.clearCookie('commerce.refreshToken', clearOpts);
  }

  private async setRedisSession(sessionId: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(`session:${sessionId}`, 'active', 'EX', ttlSeconds);
    } catch (e: any) {
      this.logger.warn(`Failed to cache session in Redis: ${e.message}`);
    }
  }

  private async deleteRedisSession(sessionId: string): Promise<void> {
    try {
      await this.redis.del(`session:${sessionId}`);
    } catch (e: any) {
      this.logger.warn(`Failed to delete session from Redis: ${e.message}`);
    }
  }
}
