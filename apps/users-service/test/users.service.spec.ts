import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from '../src/modules/users/users.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { SessionService } from '../src/modules/auth/services/session.service';
import { UserRole, UserStatus } from '@libs/shared-types';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserEntity } from '../src/modules/users/user.entity';

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<UsersRepository>;
  let sessionService: jest.Mocked<SessionService>;

  const mockUser: UserEntity = {
    id: 'user-1',
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
    const mockRepository = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findAll: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    const mockSessionService = {
      revokeAllUserSessions: jest.fn().mockResolvedValue(1),
      revokeSession: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: UsersRepository,
          useValue: mockRepository,
        },
        {
          provide: SessionService,
          useValue: mockSessionService,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    repository = module.get(UsersRepository);
    sessionService = module.get(SessionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findById', () => {
    it('should return a user if found', async () => {
      repository.findById.mockResolvedValue(mockUser);
      const result = await service.findById('user-1');
      expect(result).toEqual(mockUser);
      expect(repository.findById).toHaveBeenCalledWith('user-1');
    });

    it('should return null if not found', async () => {
      repository.findById.mockResolvedValue(null);
      const result = await service.findById('user-999');
      expect(result).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('should return a user by email', async () => {
      repository.findByEmail.mockResolvedValue(mockUser);
      const result = await service.findByEmail('test@example.com');
      expect(result).toEqual(mockUser);
      expect(repository.findByEmail).toHaveBeenCalledWith('test@example.com');
    });
  });

  describe('create', () => {
    it('should create a new user', async () => {
      repository.save.mockResolvedValue(mockUser);
      const result = await service.create({
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: 'hashed_password',
      });
      expect(result).toEqual(mockUser);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.CUSTOMER,
          status: UserStatus.ACTIVE,
          isEmailVerified: false,
        }),
      );
    });
  });

  describe('listUsers', () => {
    it('should return paginated list of users', async () => {
      repository.findAll.mockResolvedValue({ items: [mockUser], total: 1 });
      const result = await service.listUsers({ page: 1, limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('updateRole', () => {
    it('should successfully update a user role', async () => {
      repository.findById.mockResolvedValue({ ...mockUser, role: UserRole.CUSTOMER });
      repository.save.mockImplementation(async (u) => u as UserEntity);

      const result = await service.updateRole('admin-id', 'user-1', UserRole.STAFF);
      expect(result.role).toBe(UserRole.STAFF);
    });

    it('should prevent an admin from revoking their own admin role', async () => {
      await expect(service.updateRole('admin-id', 'admin-id', UserRole.CUSTOMER)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if user not found', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.updateRole('admin-id', 'user-404', UserRole.STAFF)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    it('should update user status to SUSPENDED and revoke sessions', async () => {
      repository.findById.mockResolvedValue({ ...mockUser, status: UserStatus.ACTIVE });
      repository.save.mockImplementation(async (u) => u as UserEntity);

      const result = await service.updateStatus('admin-id', 'user-1', UserStatus.SUSPENDED);
      expect(result.status).toBe(UserStatus.SUSPENDED);
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        'user-1',
        undefined,
        expect.stringContaining(UserStatus.SUSPENDED),
      );
    });

    it('should prevent an admin from suspending their own account', async () => {
      await expect(
        service.updateStatus('admin-id', 'admin-id', UserStatus.SUSPENDED),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if user not found', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('admin-id', 'user-404', UserStatus.BANNED)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update an existing user profile', async () => {
      repository.findById.mockResolvedValue(mockUser);
      const updatedUser = { ...mockUser, name: 'Updated Name' };
      repository.save.mockResolvedValue(updatedUser);

      const result = await service.update('user-1', { name: 'Updated Name' });
      expect(result.name).toBe('Updated Name');
      expect(repository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException when updating non-existent user', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.update('user-999', { name: 'New Name' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('should delete an existing user and revoke their sessions', async () => {
      repository.findById.mockResolvedValue(mockUser);
      repository.remove.mockResolvedValue(undefined);

      await service.delete('user-1');
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        'user-1',
        undefined,
        'Account deleted',
      );
      expect(repository.remove).toHaveBeenCalledWith(mockUser);
    });

    it('should throw NotFoundException when deleting non-existent user', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.delete('user-999')).rejects.toThrow(NotFoundException);
    });
  });
});
