import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@libs/shared-types';
import { UsersRepository } from './users.repository';
import { UserEntity } from './user.entity';
import { UserResponseDto } from './dto/user-response.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PaginatedUsersResponseDto } from './dto/paginated-users-response.dto';
import { SessionService } from '../auth/services/session.service';

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role?: UserRole;
  status?: UserStatus;
}

export interface UpdateUserInput {
  name?: string;
  avatarUrl?: string | null;
  role?: UserRole;
  status?: UserStatus;
  isEmailVerified?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    @Inject(forwardRef(() => SessionService))
    private readonly sessionService: SessionService,
  ) {}

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
      status: input.status ?? UserStatus.ACTIVE,
      isEmailVerified: false,
    });
  }

  async listUsers(query: ListUsersQueryDto): Promise<PaginatedUsersResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { items, total } = await this.usersRepository.findAll(query);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items: items.map((user) => this.toResponse(user)),
      total,
      page,
      limit,
      totalPages,
    };
  }

  async updateRole(
    callerId: string,
    targetUserId: string,
    newRole: UserRole,
  ): Promise<UserResponseDto> {
    if (callerId === targetUserId && newRole !== UserRole.ADMIN) {
      throw new BadRequestException('Administrators cannot revoke their own admin role');
    }

    const user = await this.usersRepository.findById(targetUserId);
    if (!user) {
      throw new NotFoundException(`User '${targetUserId}' not found`);
    }

    user.role = newRole;
    const saved = await this.usersRepository.save(user);
    return this.toResponse(saved);
  }

  async updateStatus(
    callerId: string,
    targetUserId: string,
    newStatus: UserStatus,
  ): Promise<UserResponseDto> {
    if (callerId === targetUserId && newStatus !== UserStatus.ACTIVE) {
      throw new BadRequestException('Administrators cannot suspend or ban their own account');
    }

    const user = await this.usersRepository.findById(targetUserId);
    if (!user) {
      throw new NotFoundException(`User '${targetUserId}' not found`);
    }

    user.status = newStatus;
    const saved = await this.usersRepository.save(user);

    // If suspended or banned, immediately revoke all active sessions across Redis and DB
    if (newStatus === UserStatus.SUSPENDED || newStatus === UserStatus.BANNED) {
      await this.sessionService.revokeAllUserSessions(
        targetUserId,
        undefined,
        `Account status updated to ${newStatus} by administrator`,
      );
    }

    return this.toResponse(saved);
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

    await this.sessionService.revokeAllUserSessions(id, undefined, 'Account deleted');
    await this.usersRepository.remove(user);
  }

  async updateLastLogin(id: string): Promise<void> {
    const user = await this.usersRepository.findById(id);
    if (user) {
      user.lastLoginAt = new Date();
      await this.usersRepository.save(user);
    }
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const user = await this.usersRepository.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    user.passwordHash = passwordHash;
    await this.usersRepository.save(user);
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
      status: user.status,
      isEmailVerified: user.isEmailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}
