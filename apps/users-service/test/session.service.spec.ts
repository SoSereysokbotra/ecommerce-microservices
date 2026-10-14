import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../src/modules/auth/services/session.service';
import { SessionEntity } from '../src/modules/auth/entities/session.entity';
import { UserEntity } from '../src/modules/users/user.entity';
import { UserRole, UserStatus } from '@libs/shared-types';

describe('SessionService', () => {
  let sessionService: SessionService;
  let sessionRepo: any;
  let userRepo: any;
  let jwtService: any;

  const mockUser: UserEntity = {
    id: 'user-uuid-1',
    email: 'user@example.com',
    name: 'User One',
    passwordHash: 'hash',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
    sessions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    sessionRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'session-uuid-1' })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockUser),
    };

    jwtService = {
      signAsync: jest.fn().mockImplementation((payload) => {
        if (payload.jti) return Promise.resolve('mock-refresh-token');
        return Promise.resolve('mock-access-token');
      }),
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-uuid-1',
        sid: 'session-uuid-1',
        jti: 'jti-1',
      }),
    };

    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'jwtSecret') return 'test-secret';
        if (key === 'jwtExpiresIn') return '1h';
        if (key === 'refreshTokenExpiresIn') return '7d';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: getRepositoryToken(SessionEntity), useValue: sessionRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    sessionService = module.get<SessionService>(SessionService);
    // Mock the internal redis instance
    (sessionService as any).redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue('active'),
      del: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    };
  });

  afterEach(async () => {
    await sessionService.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(sessionService).toBeDefined();
  });

  describe('createSession', () => {
    it('should create and persist a new session and cache in Redis', async () => {
      const result = await sessionService.createSession(
        mockUser,
        'Mozilla/5.0 Test Browser',
        '127.0.0.1',
      );

      expect(result.accessToken).toEqual('mock-access-token');
      expect(result.refreshToken).toEqual('mock-refresh-token');
      expect(sessionRepo.create).toHaveBeenCalled();
      expect(sessionRepo.save).toHaveBeenCalled();
      expect((sessionService as any).redis.set).toHaveBeenCalledWith(
        expect.stringContaining('session:'),
        'active',
        'EX',
        expect.any(Number),
      );
    });
  });

  describe('rotateSession', () => {
    it('should rotate session when refresh token hash matches', async () => {
      const tokenHash = sessionService.hashToken('mock-refresh-token');
      const existingSession = {
        id: 'session-uuid-1',
        userId: 'user-uuid-1',
        tokenHash,
        prevTokenHash: null,
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: null,
        user: mockUser,
      };

      sessionRepo.findOne.mockResolvedValue(existingSession);

      const result = await sessionService.rotateSession('mock-refresh-token');

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(existingSession.prevTokenHash).toEqual(tokenHash);
      expect(sessionRepo.save).toHaveBeenCalled();
    });

    it('should detect token reuse and revoke session immediately if hash does not match', async () => {
      const existingSession = {
        id: 'session-uuid-1',
        userId: 'user-uuid-1',
        tokenHash: 'different-hash',
        prevTokenHash: 'another-different-hash',
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: null,
        user: mockUser,
      };

      sessionRepo.findOne.mockResolvedValue(existingSession);

      await expect(sessionService.rotateSession('mock-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(existingSession.revokedAt).toBeDefined();
      expect((sessionService as any).redis.del).toHaveBeenCalledWith('session:session-uuid-1');
    });
  });

  describe('revokeSession', () => {
    it('should revoke session in db and remove from redis', async () => {
      const existingSession = {
        id: 'session-uuid-1',
        userId: 'user-uuid-1',
        revokedAt: null,
      };
      sessionRepo.findOne.mockResolvedValue(existingSession);

      await sessionService.revokeSession('session-uuid-1', 'User logout');

      expect(existingSession.revokedAt).toBeDefined();
      expect(sessionRepo.save).toHaveBeenCalledWith(existingSession);
      expect((sessionService as any).redis.del).toHaveBeenCalledWith('session:session-uuid-1');
    });
  });

  describe('isSessionActive', () => {
    it('should return true when redis caches active', async () => {
      (sessionService as any).redis.get.mockResolvedValue('active');
      const active = await sessionService.isSessionActive('session-uuid-1');
      expect(active).toBe(true);
    });

    it('should return false when redis caches revoked', async () => {
      (sessionService as any).redis.get.mockResolvedValue('revoked');
      const active = await sessionService.isSessionActive('session-uuid-1');
      expect(active).toBe(false);
    });
  });

  describe('cookie helpers', () => {
    it('should set httpOnly cookies for access and refresh tokens', () => {
      const mockRes: any = {
        cookie: jest.fn(),
        clearCookie: jest.fn(),
      };

      sessionService.setAuthCookies(mockRes, 'access-123', 'refresh-456');

      expect(mockRes.cookie).toHaveBeenCalledWith(
        'commerce.accessToken',
        'access-123',
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
      );
      expect(mockRes.cookie).toHaveBeenCalledWith(
        'commerce.refreshToken',
        'refresh-456',
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
      );

      sessionService.clearAuthCookies(mockRes);
      expect(mockRes.clearCookie).toHaveBeenCalledWith('commerce.accessToken', expect.any(Object));
      expect(mockRes.clearCookie).toHaveBeenCalledWith('commerce.refreshToken', expect.any(Object));
    });
  });
});
