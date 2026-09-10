import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '../order.entity';

export class OrderLineDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;
}

export class OrderDestinationDto {
  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2.' })
  @IsString()
  @Length(2, 2)
  country: string;

  @ApiPropertyOptional({ example: 'CA', description: 'State or province code.' })
  @IsOptional()
  @IsString()
  region?: string;
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderLineDto] })
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  @ArrayMinSize(1)
  items: OrderLineDto[];

  /**
   * Where the order is taxed. Optional, because nothing in this system knows a
   * customer's address until M10 — absent, pricing-service falls back to the
   * configured store default. Whatever is used is frozen onto the order.
   */
  @ApiPropertyOptional({ type: OrderDestinationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderDestinationDto)
  destination?: OrderDestinationDto;

  /**
   * A coupon code. Optional, and unlike a quote, placing an order **claims a
   * use** — pricing holds it against this order's id, and the saga gives it
   * back if the order is later cancelled.
   */
  @ApiPropertyOptional({ example: 'SAVE10USES' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  couponCode?: string;

  /**
   * One of the customer's saved addresses.
   *
   * When given it **wins over `destination`**: the country and region are read
   * from a row this customer owns, server-side, rather than taken from a field
   * the browser filled in. That is the M8 placeholder closing — see
   * `UsersClient`. The address is also frozen onto the order.
   *
   * Still optional, because a checkout with no saved address must work.
   */
  @ApiPropertyOptional({ description: "One of the caller's saved address ids." })
  @IsOptional()
  @IsUUID()
  shippingAddressId?: string;

  /**
   * Which delivery service level to charge for — 'standard', 'express'.
   * Omitted, the cheapest available applies.
   */
  @ApiPropertyOptional({ example: 'standard' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  shippingRateCode?: string;
}

export class OrderAddressResponseDto {
  @ApiProperty() recipient: string;
  @ApiProperty() line1: string;
  @ApiPropertyOptional({ nullable: true }) line2?: string | null;
  @ApiProperty() city: string;
  @ApiPropertyOptional({ nullable: true }) region?: string | null;
  @ApiPropertyOptional({ nullable: true }) postcode?: string | null;
  @ApiProperty() country: string;
  @ApiPropertyOptional({ nullable: true }) phone?: string | null;
}

export class OrderItemResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() productId: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty() qty: number;
  @ApiProperty({ description: 'Integer minor units.' }) unitPriceMinor: number;
  @ApiProperty({ description: 'This line’s share of every discount that applied.' })
  lineDiscountMinor: number;
  @ApiProperty({ description: 'Basis points: 725 is 7.25%.' }) taxRateBp: number;
  @ApiProperty({ description: 'This line’s share of its tax group’s single rounded figure.' })
  taxMinor: number;
}

export class OrderResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() customerId: string;
  @ApiProperty({ enum: OrderStatus }) status: OrderStatus;
  @ApiProperty() currency: string;
  @ApiProperty({ description: 'The basket before anything was applied.' }) subtotalMinor: number;
  @ApiProperty({ description: 'What promotions took off, summed.' }) discountMinor: number;
  @ApiProperty({ description: 'Integer minor units.' }) taxMinor: number;
  @ApiProperty({ description: 'What delivery cost. Zero before M10, and zero when free.' })
  shippingMinor: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Which service level was charged. Null for orders placed before M10.',
  })
  shippingRateCode?: string | null;
  @ApiPropertyOptional({
    type: OrderAddressResponseDto,
    nullable: true,
    description: 'Where it is going, frozen at checkout. Null when no address was given.',
  })
  shippingAddress?: OrderAddressResponseDto | null;
  @ApiProperty({ description: 'What the customer pays. Includes tax from M8, shipping from M10.' })
  totalMinor: number;
  @ApiPropertyOptional({ nullable: true, description: 'Null for orders placed before M8.' })
  taxCountry?: string | null;
  @ApiPropertyOptional({ nullable: true }) taxRegion?: string | null;
  @ApiPropertyOptional({ nullable: true }) failureReason?: string | null;
  @ApiProperty({ type: [OrderItemResponseDto] }) items: OrderItemResponseDto[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
