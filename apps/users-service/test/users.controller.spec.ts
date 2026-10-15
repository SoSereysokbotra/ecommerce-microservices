import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from '../src/modules/users/users.controller';
import { UsersService } from '../src/modules/users/users.service';
import { UserRole, UserStatus } from '@libs/shared-types';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserResponseDto } from '../src/modules/users/dto/user-response.dto';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;

  const mockUserResponse: UserResponseDto = {
    id: 'user-1',
    email: 'user1@example.com',
    name: 'User One',
    avatarUrl: null,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    isEmailVerified: true,
    lastLoginAt: new Date(),
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const mockUsersService = {
      getProfile: jest.fn(),
      listUsers: jest.fn(),
      updateRole: jest.fn(),
      updateStatus: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    usersService = module.get(UsersService);
  });

  describe('getMe', () => {
    it('should return the caller profile', async () => {
      usersService.getProfile.mockResolvedValue(mockUserResponse);
      const result = await controller.getMe('user-1');
      expect(result).toEqual(mockUserResponse);
      expect(usersService.getProfile).toHaveBeenCalledWith('user-1');
    });

    it('should throw UnauthorizedException if header is missing', () => {
      expect(() => controller.getMe('')).toThrow(UnauthorizedException);
    });
  });

  describe('list', () => {
    it('should list users via service', async () => {
      const paginated = {
        items: [mockUserResponse],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      };
      usersService.listUsers.mockResolvedValue(paginated);

      const result = await controller.list({ page: 1, limit: 20 });
      expect(result).toEqual(paginated);
    });
  });

  describe('updateRole', () => {
    it('should update user role via service', async () => {
      usersService.updateRole.mockResolvedValue({
        ...mockUserResponse,
        role: UserRole.STAFF,
      });

      const result = await controller.updateRole('admin-1', 'user-1', { role: UserRole.STAFF });
      expect(result.role).toBe(UserRole.STAFF);
      expect(usersService.updateRole).toHaveBeenCalledWith('admin-1', 'user-1', UserRole.STAFF);
    });
  });

  describe('updateStatus', () => {
    it('should update user status via service', async () => {
      usersService.updateStatus.mockResolvedValue({
        ...mockUserResponse,
        status: UserStatus.SUSPENDED,
      });

      const result = await controller.updateStatus('admin-1', 'user-1', {
        status: UserStatus.SUSPENDED,
      });
      expect(result.status).toBe(UserStatus.SUSPENDED);
      expect(usersService.updateStatus).toHaveBeenCalledWith(
        'admin-1',
        'user-1',
        UserStatus.SUSPENDED,
      );
    });
  });

  describe('getById', () => {
    it('should allow customer to view their own profile', async () => {
      usersService.getProfile.mockResolvedValue(mockUserResponse);
      const result = await controller.getById('user-1', UserRole.CUSTOMER, 'user-1');
      expect(result).toEqual(mockUserResponse);
    });

    it('should forbid customer from viewing another customer profile', async () => {
      await expect(controller.getById('user-1', UserRole.CUSTOMER, 'user-2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow staff/admin to view another customer profile', async () => {
      usersService.getProfile.mockResolvedValue(mockUserResponse);
      const result = await controller.getById('admin-1', UserRole.ADMIN, 'user-1');
      expect(result).toEqual(mockUserResponse);
    });
  });

  describe('update', () => {
    it('should allow customer to update their own profile', async () => {
      usersService.update.mockResolvedValue(mockUserResponse);
      const result = await controller.update('user-1', UserRole.CUSTOMER, 'user-1', {
        name: 'New Name',
      });
      expect(result).toEqual(mockUserResponse);
    });

    it('should forbid customer from updating another customer profile', async () => {
      await expect(
        controller.update('user-1', UserRole.CUSTOMER, 'user-2', { name: 'Hacked' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('should allow admin to delete another user', async () => {
      usersService.delete.mockResolvedValue(undefined);
      await controller.remove('admin-1', 'user-2');
      expect(usersService.delete).toHaveBeenCalledWith('user-2');
    });

    it('should forbid admin from deleting their own account', async () => {
      await expect(controller.remove('admin-1', 'admin-1')).rejects.toThrow(BadRequestException);
    });
  });
});
