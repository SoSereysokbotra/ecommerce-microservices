import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PasswordResetService } from '../src/modules/auth/services/password-reset.service';
import { PasswordResetEntity } from '../src/modules/auth/entities/password-reset.entity';
import { UsersService } from '../src/modules/users/users.service';
import { SessionService } from '../src/modules/auth/services/session.service';
import { EventEmitterService } from '../src/events/event-emitter.service';
import { UserRole, UserStatus } from '@libs/shared-types';
import { UserEntity } from '../src/modules/users/user.entity';

jest.mock('bcrypt');

describe('PasswordResetService', () => {
  let service: PasswordResetService;
  let resetRepo: any;
  let usersService: any;
  let sessionService: any;
  let eventEmitter: any;

  const mockUser: UserEntity = {
    id: 'user-uuid-1',
    email: 'reset@example.com',
    name: 'Reset Tester',
    passwordHash: 'old-hash',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
    sessions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    resetRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'reset-uuid-1' })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
    };

    usersService = {
      findByEmail: jest.fn().mockResolvedValue(mockUser),
      updatePassword: jest.fn().mockResolvedValue(undefined),
    };

    sessionService = {
      revokeAllUserSessions: jest.fn().mockResolvedValue(2),
    };

    eventEmitter = {
      emit: jest.fn().mockResolvedValue(true),
    };

    (bcrypt.hash as jest.Mock).mockResolvedValue('new-hashed-password');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        { provide: getRepositoryToken(PasswordResetEntity), useValue: resetRepo },
        { provide: UsersService, useValue: usersService },
        { provide: SessionService, useValue: sessionService },
        { provide: EventEmitterService, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<PasswordResetService>(PasswordResetService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('requestPasswordReset', () => {
    it('should generate a token, save SHA-256 hash, and emit event for active user', async () => {
      const response = await service.requestPasswordReset('reset@example.com');

      expect(response.success).toBe(true);
      expect(response.message).toContain('password reset instructions have been sent');
      expect(resetRepo.update).toHaveBeenCalled();
      expect(resetRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-uuid-1',
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      );
      expect(resetRepo.save).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'auth.password-reset.requested',
        expect.objectContaining({
          userId: 'user-uuid-1',
          email: 'reset@example.com',
          rawToken: expect.any(String),
        }),
      );
    });

    it('should return generic success response without saving if user does not exist (anti-enumeration)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const response = await service.requestPasswordReset('nonexistent@example.com');

      expect(response.success).toBe(true);
      expect(resetRepo.create).not.toHaveBeenCalled();
      expect(resetRepo.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return generic success response without saving if user is suspended', async () => {
      usersService.findByEmail.mockResolvedValue({ ...mockUser, status: UserStatus.SUSPENDED });

      const response = await service.requestPasswordReset('reset@example.com');

      expect(response.success).toBe(true);
      expect(resetRepo.create).not.toHaveBeenCalled();
      expect(resetRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('confirmPasswordReset', () => {
    it('should update password and revoke all active user sessions', async () => {
      const rawToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const tokenHash = service.hashToken(rawToken);

      const existingRecord = {
        id: 'reset-uuid-1',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes in future
        usedAt: null,
      };

      resetRepo.findOne.mockResolvedValue(existingRecord);

      const response = await service.confirmPasswordReset(rawToken, 'NewSecurePassword123');

      expect(response.success).toBe(true);
      expect(bcrypt.hash).toHaveBeenCalledWith('NewSecurePassword123', 10);
      expect(usersService.updatePassword).toHaveBeenCalledWith(
        'user-uuid-1',
        'new-hashed-password',
      );
      expect(existingRecord.usedAt).toBeDefined();
      expect(resetRepo.save).toHaveBeenCalledWith(existingRecord);
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        'user-uuid-1',
        undefined,
        'Password reset',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'auth.password-reset.completed',
        expect.objectContaining({ userId: 'user-uuid-1' }),
      );
    });

    it('should throw BadRequestException if token is not found or already used', async () => {
      resetRepo.findOne.mockResolvedValue(null);

      await expect(service.confirmPasswordReset('invalid-token', 'NewPassword123')).rejects.toThrow(
        BadRequestException,
      );

      expect(usersService.updatePassword).not.toHaveBeenCalled();
      expect(sessionService.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if token is expired', async () => {
      const rawToken = 'expired-token';
      const existingRecord = {
        id: 'reset-uuid-1',
        userId: 'user-uuid-1',
        tokenHash: service.hashToken(rawToken),
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
        usedAt: null,
      };

      resetRepo.findOne.mockResolvedValue(existingRecord);

      await expect(service.confirmPasswordReset(rawToken, 'NewPassword123')).rejects.toThrow(
        BadRequestException,
      );

      expect(existingRecord.usedAt).toBeDefined();
      expect(resetRepo.save).toHaveBeenCalledWith(existingRecord);
      expect(usersService.updatePassword).not.toHaveBeenCalled();
      expect(sessionService.revokeAllUserSessions).not.toHaveBeenCalled();
    });
  });
});
