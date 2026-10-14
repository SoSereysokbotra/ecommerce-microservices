import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class PasswordResetConfirmDto {
  @ApiProperty({ description: 'Raw reset token received via email/notification' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ description: 'New password (minimum 8 characters)', minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}
