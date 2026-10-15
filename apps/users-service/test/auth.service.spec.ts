import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersService } from '../src/modules/users/users.service';
import { SessionService } from '../src/modules/auth/services/session.service';
import { EventEmitterService } from '../src/events/event-emitter.service';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserRole, UserStatus } from '@libs/shared-types';
import { UserEntity } from '../src/modules/users/user.entity';

// Mock bcrypt
jest.mock('bcrypt');

describe('AuthService', () => {
  let authService: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let sessionService: jest.Mocked<SessionService>;
  let eventEmitter: jest.Mocked<EventEmitterService>;

  const mockUser: UserEntity = {
    id: '1',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed_password',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    isEmailVerified: false,
    sessions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockUsersService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      updateLastLogin: jest.fn(),
    };
    const mockSessionService = {
      createSession: jest.fn().mockResolvedValue({
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        session: { id: 'session-123', userId: '1' },
      }),
      rotateSession: jest.fn().mockResolvedValue({
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
        session: { id: 'session-123', userId: '1' },
      }),
      revokeSession: jest.fn(),
      revokeAllUserSessions: jest.fn(),
      listUserSessions: jest.fn(),
      isSessionActive: jest.fn(),
    };
    const mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: EventEmitterService, useValue: mockEventEmitter },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
    usersService = module.get(UsersService);
    sessionService = module.get(SessionService);
    eventEmitter = module.get(EventEmitterService);
  });

  it('should be defined', () => {
    expect(authService).toBeDefined();
  });

  describe('register', () => {
    it('should register a new user and return tokens', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');
      usersService.create.mockResolvedValue(mockUser);

      const result = await authService.register('test@example.com', 'Test User', 'password');

      expect(result.accessToken).toEqual('access_token');
      expect(result.refreshToken).toEqual('refresh_token');
      expect(result.user.email).toEqual('test@example.com');
      expect(eventEmitter.emit).toHaveBeenCalledWith('user.created', expect.any(Object));
      expect(sessionService.createSession).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if email already registered', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      await expect(
        authService.register('test@example.com', 'Test User', 'password'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('login', () => {
    it('should authenticate user and return tokens', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await authService.login('test@example.com', 'password');

      expect(result.accessToken).toEqual('access_token');
      expect(result.refreshToken).toEqual('refresh_token');
      expect(result.user.email).toEqual('test@example.com');
      expect(sessionService.createSession).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if invalid password', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(authService.login('test@example.com', 'wrong_password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException if user not found', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(authService.login('notfound@example.com', 'password')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refreshToken', () => {
    it('should issue new tokens if refresh token is valid', async () => {
      usersService.findById.mockResolvedValue(mockUser);

      const result = await authService.refreshToken('valid_token');

      expect(result.accessToken).toEqual('new_access_token');
      expect(result.refreshToken).toEqual('new_refresh_token');
      expect(sessionService.rotateSession).toHaveBeenCalledWith(
        'valid_token',
        undefined,
        undefined,
      );
    });

    it('should throw UnauthorizedException if user not found during refresh', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(authService.refreshToken('valid_token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if no token is provided', async () => {
      await expect(authService.refreshToken('')).rejects.toThrow(UnauthorizedException);
    });
  });
});
