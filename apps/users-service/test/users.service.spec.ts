import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from '../src/modules/users/users.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { UserRole } from '@libs/shared-types';
import { NotFoundException } from '@nestjs/common';
import { UserEntity } from '../src/modules/users/user.entity';

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<UsersRepository>;

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
    const mockRepository = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: UsersRepository,
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    repository = module.get(UsersRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findById', () => {
    it('should return a user if found', async () => {
      repository.findById.mockResolvedValue(mockUser);
      const result = await service.findById('1');
      expect(result).toEqual(mockUser);
      expect(repository.findById).toHaveBeenCalledWith('1');
    });

    it('should return null if not found', async () => {
      repository.findById.mockResolvedValue(null);
      const result = await service.findById('999');
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
          isEmailVerified: false,
        }),
      );
    });
  });

  describe('update', () => {
    it('should update an existing user', async () => {
      repository.findById.mockResolvedValue(mockUser);
      const updatedUser = { ...mockUser, name: 'Updated Name' };
      repository.save.mockResolvedValue(updatedUser);

      const result = await service.update('1', { name: 'Updated Name' });
      expect(result.name).toEqual('Updated Name');
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Updated Name' }),
      );
    });

    it('should throw NotFoundException if user not found', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.update('999', { name: 'Updated Name' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('should remove a user', async () => {
      repository.findById.mockResolvedValue(mockUser);
      repository.remove.mockResolvedValue(undefined);

      await service.delete('1');
      expect(repository.remove).toHaveBeenCalledWith(mockUser);
    });

    it('should throw NotFoundException if user to delete is not found', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.delete('999')).rejects.toThrow(NotFoundException);
    });
  });
});
