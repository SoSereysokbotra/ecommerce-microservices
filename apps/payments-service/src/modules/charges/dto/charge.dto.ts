import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, IsUUID, Length, Min } from 'class-validator';

export class ChargeDto {
  @ApiProperty()
  @IsUUID()
  orderId: string;

  @ApiProperty({ description: 'Integer minor units.', example: 4998 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountMinor: number;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3)
  currency: string;
}

export class ChargeResultDto {
  @ApiProperty({ enum: ['AUTHORIZED', 'DECLINED'] })
  status: 'AUTHORIZED' | 'DECLINED';

  @ApiProperty() orderId: string;
  @ApiProperty() amountMinor: number;
  @ApiProperty() currency: string;
  @ApiProperty({ description: 'Fake provider reference.' }) reference: string;
}
