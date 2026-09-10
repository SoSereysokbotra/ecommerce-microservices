import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { ShipmentStatus } from '../shipment.entity';

export class DispatchShipmentDto {
  @ApiPropertyOptional({ example: 'DHL' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  carrier?: string;

  @ApiPropertyOptional({ example: 'JD0002210123456789' })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  trackingCode?: string;
}

export class ShipmentAddressDto {
  @ApiProperty() recipient: string;
  @ApiProperty() line1: string;
  @ApiPropertyOptional({ nullable: true }) line2?: string | null;
  @ApiProperty() city: string;
  @ApiPropertyOptional({ nullable: true }) region?: string | null;
  @ApiPropertyOptional({ nullable: true }) postcode?: string | null;
  @ApiProperty() country: string;
  @ApiPropertyOptional({ nullable: true }) phone?: string | null;
}

export class ShipmentResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() orderId: string;
  @ApiProperty() customerId: string;
  @ApiProperty({ enum: ShipmentStatus }) status: ShipmentStatus;
  @ApiPropertyOptional({ nullable: true, description: 'Service level charged for.' })
  rateCode: string | null;
  @ApiProperty({ description: 'What delivery cost. Zero when it was free.' }) costMinor: number;
  @ApiProperty({ description: 'What it was rated on, in grams.' }) weightG: number;
  @ApiPropertyOptional({ type: ShipmentAddressDto, nullable: true })
  address: ShipmentAddressDto | null;
  @ApiPropertyOptional({ nullable: true }) carrier: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingCode: string | null;
  @ApiPropertyOptional({ nullable: true }) dispatchedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) deliveredAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
