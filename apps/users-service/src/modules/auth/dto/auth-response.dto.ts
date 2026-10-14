import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiPropertyOptional()
  sessionId?: string;

  @ApiProperty({ type: () => UserResponseDto })
  user: UserResponseDto;
}
