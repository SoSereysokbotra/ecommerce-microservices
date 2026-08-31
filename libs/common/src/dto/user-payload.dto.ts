import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@libs/shared-types';

export class UserPayloadDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  sub: string;

  @ApiProperty({ example: 'john@example.com' })
  email: string;

  @ApiProperty({ enum: UserRole, example: UserRole.CUSTOMER })
  role: UserRole;
}
