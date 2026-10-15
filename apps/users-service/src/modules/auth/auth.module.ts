import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { UserEntity } from '../users/user.entity';
import { SessionEntity } from './entities/session.entity';
import { PasswordResetEntity } from './entities/password-reset.entity';
import { SessionService } from './services/session.service';
import { PasswordResetService } from './services/password-reset.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    PassportModule,
    TypeOrmModule.forFeature([SessionEntity, PasswordResetEntity, UserEntity]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwtSecret') ?? 'change-me',
        signOptions: { expiresIn: configService.get<string>('jwtExpiresIn') ?? '1h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionService, PasswordResetService, JwtStrategy, LocalStrategy],
  exports: [AuthService, SessionService, PasswordResetService],
})
export class AuthModule {}
