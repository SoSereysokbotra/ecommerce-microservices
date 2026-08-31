import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Validation failed' })
  message: string;

  @ApiProperty({ example: 'Bad Request', required: false })
  error?: string;

  @ApiProperty({ example: '2026-05-25T12:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/users', required: false })
  path?: string;
}
