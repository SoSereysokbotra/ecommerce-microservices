import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserRole } from '@libs/shared-types';
import { EventEmitterService } from '../../events/event-emitter.service';
import { UsersService } from '../users/users.service';
import { UserEntity } from '../users/user.entity';
import { AuthResponseDto } from './dto/auth-response.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitterService,
  ) {}

  async register(
    email: string,
    name: string,
    password: string,
    role: UserRole = UserRole.CUSTOMER,
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
    return this.issueTokens(user);
  }

  async login(email: string, password: string): Promise<AuthResponseDto> {
    const user = await this.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokens(user);
  }

  async validateUser(email: string, password: string): Promise<UserEntity | null> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return null;
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    return passwordMatches ? user : null;
  }

  async refreshToken(token: string): Promise<AuthResponseDto> {
    const secret = this.configService.get<string>('jwtSecret') ?? 'change-me';
    const payload = this.jwtService.verify<{ sub: string; email: string; role: UserRole }>(token, {
      secret,
    });

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    return this.issueTokens(user);
  }

  private async issueTokens(user: UserEntity): Promise<AuthResponseDto> {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('jwtSecret') ?? 'change-me',
      expiresIn: this.configService.get<string>('jwtExpiresIn') ?? '1h',
    });
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('jwtSecret') ?? 'change-me',
      expiresIn: this.configService.get<string>('refreshTokenExpiresIn') ?? '7d',
    });

    return {
      accessToken,
      refreshToken,
      user: this.mapUser(user),
    };
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
