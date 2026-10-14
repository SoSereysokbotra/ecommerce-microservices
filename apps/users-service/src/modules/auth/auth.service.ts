import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserRole, UserStatus } from '@libs/shared-types';
import { EventEmitterService } from '../../events/event-emitter.service';
import { UsersService } from '../users/users.service';
import { UserEntity } from '../users/user.entity';
import { AuthResponseDto } from './dto/auth-response.dto';
import { SessionService } from './services/session.service';
import { SessionEntity } from './entities/session.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly sessionService: SessionService,
    private readonly eventEmitter: EventEmitterService,
  ) {}

  async register(
    email: string,
    name: string,
    password: string,
    role: UserRole = UserRole.CUSTOMER,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<AuthResponseDto> {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new UnauthorizedException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.usersService.create({ email, name, passwordHash, role });

    await this.eventEmitter.emit('user.created', {
      userId: user.id,
      email: user.email,
      role: user.role,
      timestamp: new Date().toISOString(),
    });

    await this.usersService.updateLastLogin(user.id);
    const sessionResult = await this.sessionService.createSession(user, userAgent, ipAddress);

    return {
      accessToken: sessionResult.accessToken,
      refreshToken: sessionResult.refreshToken,
      sessionId: sessionResult.session.id,
      user: this.mapUser(user),
    };
  }

  async login(
    email: string,
    password: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<AuthResponseDto> {
    const user = await this.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    this.assertUserCanLogin(user);

    await this.usersService.updateLastLogin(user.id);
    const sessionResult = await this.sessionService.createSession(user, userAgent, ipAddress);

    return {
      accessToken: sessionResult.accessToken,
      refreshToken: sessionResult.refreshToken,
      sessionId: sessionResult.session.id,
      user: this.mapUser(user),
    };
  }

  async validateUser(email: string, password: string): Promise<UserEntity | null> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return null;
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    return passwordMatches ? user : null;
  }

  async refreshToken(
    rawRefreshToken: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<AuthResponseDto> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    const sessionResult = await this.sessionService.rotateSession(
      rawRefreshToken,
      userAgent,
      ipAddress,
    );

    const user = await this.usersService.findById(sessionResult.session.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    this.assertUserCanLogin(user);

    return {
      accessToken: sessionResult.accessToken,
      refreshToken: sessionResult.refreshToken,
      sessionId: sessionResult.session.id,
      user: this.mapUser(user),
    };
  }

  async logout(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.sessionService.revokeSession(sessionId, 'User logout');
    }
  }

  async listSessions(userId: string): Promise<SessionEntity[]> {
    return this.sessionService.listUserSessions(userId);
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const sessions = await this.sessionService.listUserSessions(userId);
    const belongsToUser = sessions.some((s) => s.id === sessionId);
    if (!belongsToUser) {
      throw new NotFoundException('Session not found or does not belong to you');
    }
    await this.sessionService.revokeSession(sessionId, 'User revoked session');
  }

  async revokeAllOtherSessions(userId: string, currentSessionId?: string): Promise<number> {
    return this.sessionService.revokeAllUserSessions(
      userId,
      currentSessionId,
      'Remote logout of other devices',
    );
  }

  private assertUserCanLogin(user: UserEntity): void {
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('Your account has been suspended. Please contact support.');
    }
    if (user.status === UserStatus.BANNED) {
      throw new ForbiddenException('Your account has been banned.');
    }
  }

  private mapUser(user: UserEntity) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    };
  }
}
