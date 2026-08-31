import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersService } from '../src/modules/users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitterService } from '../src/events/event-emitter.service';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserRole } from '@libs/shared-types';
import { UserEntity } from '../src/modules/users/user.entity';

// Mock bcrypt
jest.mock('bcrypt');

describe('AuthService', () => {
  let authService: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;
  let eventEmitter: jest.Mocked<EventEmitterService>;

  const mockUser: UserEntity = {
    id: '1',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed_password',
    role: UserRole.CUSTOMER,
    isEmailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockUsersService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
    };
    const mockJwtService = {
      signAsync: jest.fn(),
      verify: jest.fn(),
    };
    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'jwtSecret') return 'secret';
        if (key === 'jwtExpiresIn') return '1h';
        if (key === 'refreshTokenExpiresIn') return '7d';
        return null;
      }),
    };
    const mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EventEmitterService, useValue: mockEventEmitter },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
    usersService = module.get(UsersService);
    jwtService = module.get(JwtService);
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
      jwtService.signAsync
        .mockResolvedValueOnce('access_token')
        .mockResolvedValueOnce('refresh_token');

      const result = await authService.register('test@example.com', 'Test User', 'password');

      expect(result.accessToken).toEqual('access_token');
      expect(result.refreshToken).toEqual('refresh_token');
      expect(result.user.email).toEqual('test@example.com');
      expect(eventEmitter.emit).toHaveBeenCalledWith('user.created', expect.any(Object));
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
      jwtService.signAsync
        .mockResolvedValueOnce('access_token')
        .mockResolvedValueOnce('refresh_token');

      const result = await authService.login('test@example.com', 'password');

      expect(result.accessToken).toEqual('access_token');
      expect(result.refreshToken).toEqual('refresh_token');
      expect(result.user.email).toEqual('test@example.com');
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
      jwtService.verify.mockReturnValue({
        sub: '1',
        email: 'test@example.com',
        role: UserRole.CUSTOMER,
      });
      usersService.findById.mockResolvedValue(mockUser);
      jwtService.signAsync
        .mockResolvedValueOnce('new_access_token')
        .mockResolvedValueOnce('new_refresh_token');

      const result = await authService.refreshToken('valid_token');

      expect(result.accessToken).toEqual('new_access_token');
      expect(result.refreshToken).toEqual('new_refresh_token');
    });

    it('should throw UnauthorizedException if user not found during refresh', async () => {
      jwtService.verify.mockReturnValue({
        sub: '999',
        email: 'test@example.com',
        role: UserRole.CUSTOMER,
      });
      usersService.findById.mockResolvedValue(null);

      await expect(authService.refreshToken('valid_token')).rejects.toThrow(UnauthorizedException);
    });
  });
});
