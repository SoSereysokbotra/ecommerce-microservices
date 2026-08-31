import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@libs/shared-types';
import { UsersRepository } from './users.repository';
import { UserEntity } from './user.entity';
import { UserResponseDto } from './dto/user-response.dto';

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  name?: string;
  avatarUrl?: string | null;
  role?: UserRole;
  isEmailVerified?: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  findById(id: string): Promise<UserEntity | null> {
    return this.usersRepository.findById(id);
  }

  findByEmail(email: string): Promise<UserEntity | null> {
    return this.usersRepository.findByEmail(email);
  }

  create(input: CreateUserInput): Promise<UserEntity> {
    return this.usersRepository.save({
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? UserRole.CUSTOMER,
      isEmailVerified: false,
    });
  }

  async update(id: string, input: UpdateUserInput): Promise<UserResponseDto> {
    const user = await this.usersRepository.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    Object.assign(user, input);
    return this.toResponse(await this.usersRepository.save(user));
  }

  async delete(id: string): Promise<void> {
    const user = await this.usersRepository.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.usersRepository.remove(user);
  }

  async getProfile(id: string): Promise<UserResponseDto> {
    const user = await this.usersRepository.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toResponse(user);
  }

  private toResponse(user: UserEntity): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    };
  }
}
