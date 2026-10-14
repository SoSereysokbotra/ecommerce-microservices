import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { CurrentUser, Public } from '@libs/common';
import { JwtPayload } from '@libs/shared-types';
import { AuthService } from './auth.service';
import { SessionService } from './services/session.service';
import { PasswordResetService } from './services/password-reset.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;

    const result = await this.authService.register(
      dto.email,
      dto.name,
      dto.password,
      dto.role,
      userAgent,
      ipAddress,
    );

    this.sessionService.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;

    const result = await this.authService.login(
      dto.email,
      dto.password,
      userAgent,
      ipAddress,
    );

    this.sessionService.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') bodyToken?: string,
  ) {
    const refreshToken = req.cookies?.['commerce.refreshToken'] || bodyToken;
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;

    const result = await this.authService.refreshToken(
      refreshToken,
      userAgent,
      ipAddress,
    );

    this.sessionService.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.sessionService.clearAuthCookies(res);
    if (user?.sid) {
      await this.authService.logout(user.sid);
    }
    return { success: true, message: 'Logged out successfully' };
  }

  @Public()
  @Post('password-reset/request')
  async requestPasswordReset(@Body() dto: PasswordResetRequestDto) {
    return this.passwordResetService.requestPasswordReset(dto.email);
  }

  @Public()
  @Post('password-reset/confirm')
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto) {
    return this.passwordResetService.confirmPasswordReset(dto.token, dto.newPassword);
  }

  @ApiBearerAuth()
  @Get('sessions')
  async listSessions(@CurrentUser() user: JwtPayload) {
    const sessions = await this.authService.listSessions(user.sub);
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      isCurrent: s.id === user.sid,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  async revokeSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authService.revokeSession(sessionId, user.sub);
    return { success: true, message: 'Session revoked successfully' };
  }

  @ApiBearerAuth()
  @Delete('sessions')
  async revokeAllOtherSessions(@CurrentUser() user: JwtPayload) {
    const count = await this.authService.revokeAllOtherSessions(user.sub, user.sid);
    return {
      success: true,
      message: `Successfully logged out of ${count} other device(s)`,
      revokedCount: count,
    };
  }
}
