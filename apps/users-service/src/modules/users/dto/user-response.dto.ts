import { ApiProperty } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@libs/shared-types';

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiProperty()
  isEmailVerified: boolean;

  @ApiProperty({ required: false, nullable: true })
  lastLoginAt?: Date | null;

  @ApiProperty()
  createdAt: Date;
}
