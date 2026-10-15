import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';
import { UserRole } from '@libs/shared-types';

export class UpdateUserRoleDto {
  @ApiProperty({ enum: UserRole, example: UserRole.STAFF })
  @IsNotEmpty()
  @IsEnum(UserRole)
  role: UserRole;
}
