import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, Roles, USER_ID_HEADER, USER_ROLE_HEADER } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { PaginatedUsersResponseDto } from './dto/paginated-users-response.dto';
import { UserResponseDto } from './dto/user-response.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * The caller's own profile, for a service that needs their name.
   */
  @Public()
  @Get('me')
  @ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
  @ApiOperation({ summary: 'The calling user, identified by the gateway' })
  getMe(@Headers(USER_ID_HEADER) userId: string) {
    if (!userId) {
      throw new UnauthorizedException('No authenticated user');
    }
    return this.usersService.getProfile(userId);
  }

  /**
   * Paginated listing of users with query filters (Admin/Staff only).
   */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'List users with pagination and filters (Admin/Staff)' })
  @ApiOkResponse({ type: PaginatedUsersResponseDto })
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedUsersResponseDto> {
    return this.usersService.listUsers(query);
  }

  /**
   * Update user role (Admin only).
   */
  @Patch(':id/role')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update user role (Admin only)' })
  @ApiOkResponse({ type: UserResponseDto })
  updateRole(
    @Headers(USER_ID_HEADER) callerId: string,
    @Param('id') id: string,
    @Body() body: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateRole(callerId, id, body.role);
  }

  /**
   * Update user lifecycle status (Admin only).
   * Automatically revokes all active sessions if status is SUSPENDED or BANNED.
   */
  @Patch(':id/status')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update user status: active, suspended, or banned (Admin only)' })
  @ApiOkResponse({ type: UserResponseDto })
  updateStatus(
    @Headers(USER_ID_HEADER) callerId: string,
    @Param('id') id: string,
    @Body() body: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateStatus(callerId, id, body.status);
  }

  /**
   * Get user profile by id.
   * Customers can only read their own profile; staff and admin can view any profile.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get user profile by id' })
  @ApiOkResponse({ type: UserResponseDto })
  async getById(
    @Headers(USER_ID_HEADER) callerId: string,
    @Headers(USER_ROLE_HEADER) callerRole: string,
    @Param('id') id: string,
  ): Promise<UserResponseDto> {
    if (callerRole === UserRole.CUSTOMER && callerId && callerId !== id) {
      throw new ForbiddenException('You can only view your own profile');
    }
    return this.usersService.getProfile(id);
  }

  /**
   * Update user profile.
   * Customers can only update their own profile; admin can update any profile.
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiOkResponse({ type: UserResponseDto })
  async update(
    @Headers(USER_ID_HEADER) callerId: string,
    @Headers(USER_ROLE_HEADER) callerRole: string,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ): Promise<UserResponseDto> {
    if (callerRole === UserRole.CUSTOMER && callerId && callerId !== id) {
      throw new ForbiddenException('You can only update your own profile');
    }
    return this.usersService.update(id, body);
  }

  /**
   * Delete user account (Admin only).
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete user account (Admin only)' })
  async remove(
    @Headers(USER_ID_HEADER) callerId: string,
    @Param('id') id: string,
  ): Promise<void> {
    if (callerId === id) {
      throw new BadRequestException('Administrators cannot delete their own account');
    }
    return this.usersService.delete(id);
  }
}
