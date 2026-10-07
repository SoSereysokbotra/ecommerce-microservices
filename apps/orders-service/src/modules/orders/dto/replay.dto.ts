import { ApiProperty } from '@nestjs/swagger';

export class ReplayCoPurchasesResponseDto {
  @ApiProperty({ description: 'Number of confirmed orders replayed into outbox.' })
  orders: number;

  @ApiProperty({
    description: 'Guidance on resetting recommendations read model before replay.',
    example: 'Truncate product_recommendations before replaying, or counts double.',
  })
  next: string;
}
