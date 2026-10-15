import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@libs/shared-types';

export const ROLES_KEY = 'roles';

/**
 * Decorator to declare required user roles on controllers or endpoints.
 * Example:
 *   @Roles(UserRole.ADMIN, UserRole.STAFF)
 *   @Get('dashboard')
 */
export const Roles = (...roles: (UserRole | string)[]) => SetMetadata(ROLES_KEY, roles);
