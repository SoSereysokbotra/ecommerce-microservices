import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

export class HoldCouponDto {
  @ApiProperty({ example: 'SAVE10USES' })
  @IsString()
  @Length(1, 64)
  code: string;

  /**
   * The order the use is being claimed for.
   *
   * orders-service generates this id **before** creating the order, so the hold
   * and the order agree on it. It is also the idempotency key: a second hold for
   * the same order is refused by `UQ_coupon_redemptions_order` rather than
   * claiming a second use.
   */
  @ApiProperty()
  @IsUUID()
  orderId: string;

  @ApiProperty()
  @IsUUID()
  customerId: string;

  @ApiProperty({ description: 'What the coupon took off, in integer minor units.' })
  @IsInt()
  @Min(0)
  amountMinor: number;
}

export class CreateCouponDto {
  @ApiProperty({ example: 'SAVE20' })
  @IsString()
  @Length(1, 64)
  code: string;

  @ApiProperty()
  @IsUUID()
  discountId: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  perCustomerLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

