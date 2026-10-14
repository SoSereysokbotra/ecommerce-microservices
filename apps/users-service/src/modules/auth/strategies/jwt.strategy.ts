import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { JwtPayload, UserStatus } from '@libs/shared-types';
import { SessionService } from '../services/session.service';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly sessionService: SessionService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => {
          if (req && req.cookies && req.cookies['commerce.accessToken']) {
            return req.cookies['commerce.accessToken'];
          }
          return null;
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwtSecret') ?? 'change-me',
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (payload.sid) {
      const isActive = await this.sessionService.isSessionActive(payload.sid);
      if (!isActive) {
        throw new UnauthorizedException('Session has been revoked or expired');
      }
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User account no longer exists');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Account has been suspended. Please contact support.');
    }
    if (user.status === UserStatus.BANNED) {
      throw new UnauthorizedException('Account has been banned.');
    }

    return payload;
  }
}
