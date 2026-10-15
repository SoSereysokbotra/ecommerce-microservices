import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { UserStatus } from '@libs/shared-types';
import { PasswordResetEntity } from '../entities/password-reset.entity';
import { UsersService } from '../../users/users.service';
import { SessionService } from './session.service';
import { EventEmitterService } from '../../../events/event-emitter.service';

export interface PasswordResetResponse {
  success: boolean;
  message: string;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private static readonly GENERIC_RESPONSE: PasswordResetResponse = {
    success: true,
    message: 'If an account exists for this email, password reset instructions have been sent.',
  };

  constructor(
    @InjectRepository(PasswordResetEntity)
    private readonly resetRepo: Repository<PasswordResetEntity>,
    private readonly usersService: UsersService,
    private readonly sessionService: SessionService,
    private readonly eventEmitter: EventEmitterService,
  ) {}

  /**
   * Hashes a raw token string using SHA-256 hex encoding.
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Initiates a password reset request. Generates a 32-byte secure token,
   * stores only its SHA-256 hash in PostgreSQL, and emits an event for email delivery.
   * Always returns a generic success response to prevent email enumeration attacks.
   */
  async requestPasswordReset(email: string): Promise<PasswordResetResponse> {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      this.logger.warn(`Password reset requested for non-existent email: ${email}`);
      return PasswordResetService.GENERIC_RESPONSE;
    }

    if (user.status !== UserStatus.ACTIVE) {
      this.logger.warn(
        `Password reset requested for non-active user ${user.id} (status: ${user.status})`,
      );
      return PasswordResetService.GENERIC_RESPONSE;
    }

    // Invalidate any existing unused reset tokens for this user
    await this.resetRepo.update({ userId: user.id, usedAt: IsNull() }, { usedAt: new Date() });

    // Generate 32-byte cryptographically secure random token (64 hex characters)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    // 15-minute expiration window
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const resetRecord = this.resetRepo.create({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    await this.resetRepo.save(resetRecord);

    try {
      await this.eventEmitter.emit('auth.password-reset.requested', {
        userId: user.id,
        email: user.email,
        name: user.name,
        rawToken,
        expiresAt: expiresAt.toISOString(),
      });
      this.logger.log(`Password reset token generated and event emitted for user ${user.id}`);
    } catch (err: any) {
      this.logger.error(`Failed to emit password-reset.requested event: ${err.message}`, err.stack);
    }

    return PasswordResetService.GENERIC_RESPONSE;
  }

  /**
   * Confirms a password reset with the one-time raw token and new password.
   * Verifies the token hash, checks expiration, updates user password,
   * and terminates ALL active sessions for that user across all devices.
   */
  async confirmPasswordReset(
    rawToken: string,
    newPassword: string,
  ): Promise<PasswordResetResponse> {
    if (!rawToken || !newPassword) {
      throw new BadRequestException('Token and new password are required');
    }

    const incomingHash = this.hashToken(rawToken);

    const resetRecord = await this.resetRepo.findOne({
      where: { tokenHash: incomingHash, usedAt: IsNull() },
    });

    if (!resetRecord) {
      this.logger.warn('Password reset failed: token not found or already used');
      throw new BadRequestException('Invalid or expired password reset token');
    }

    if (new Date() > resetRecord.expiresAt) {
      resetRecord.usedAt = new Date();
      await this.resetRepo.save(resetRecord);
      this.logger.warn(`Password reset token expired for user ${resetRecord.userId}`);
      throw new BadRequestException('Password reset token has expired');
    }

    // 1. Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // 2. Update user's password in database
    await this.usersService.updatePassword(resetRecord.userId, passwordHash);

    // 3. Mark reset token as used immediately
    resetRecord.usedAt = new Date();
    await this.resetRepo.save(resetRecord);

    // 4. Critical Security Step: Revoke ALL active sessions across all devices!
    try {
      const revokedCount = await this.sessionService.revokeAllUserSessions(
        resetRecord.userId,
        undefined,
        'Password reset',
      );
      this.logger.log(
        `Revoked ${revokedCount} active sessions for user ${resetRecord.userId} after password reset`,
      );
    } catch (err: any) {
      this.logger.warn(`Failed to revoke sessions during password reset: ${err.message}`);
    }

    // 5. Emit password reset completed event
    try {
      await this.eventEmitter.emit('auth.password-reset.completed', {
        userId: resetRecord.userId,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(`Failed to emit password-reset.completed event: ${err.message}`);
    }

    return {
      success: true,
      message: 'Password has been reset successfully. Please log in with your new password.',
    };
  }
}
