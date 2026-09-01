import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaymentStatus } from '../payment.entity';

export class PaymentResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() orderId: string;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiProperty({ description: 'Integer minor units.' }) amountMinor: number;
  @ApiProperty() currency: string;
  @ApiPropertyOptional({ nullable: true, description: 'For Stripe.js on the storefront.' })
  clientSecret?: string | null;
  @ApiPropertyOptional({ nullable: true }) failureReason?: string | null;
  @ApiProperty() createdAt: Date;
}

export class RefundRequestDto {
  @ApiProperty()
  @IsUUID()
  orderId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
