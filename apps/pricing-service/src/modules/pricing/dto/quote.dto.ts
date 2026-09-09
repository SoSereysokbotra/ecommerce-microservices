import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class QuoteLineDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;
}

export class DestinationDto {
  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2.' })
  @IsString()
  @Length(2, 2)
  country: string;

  @ApiPropertyOptional({ example: 'CA', description: 'State or province code.' })
  @IsOptional()
  @IsString()
  region?: string;
}

export class CreateQuoteDto {
  /**
   * An empty basket is allowed, unlike `POST /orders` which requires at least
   * one line. The storefront asks for a quote whenever the cart changes, and a
   * cart the shopper has just emptied is a legitimate thing to price at zero
   * rather than an error to render.
   */
  @ApiProperty({ type: [QuoteLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  items: QuoteLineDto[];

  /**
   * Where the basket is taxed. Optional: nothing in this system knows a
   * customer's address until M10, so absent it falls back to the configured
   * store default — see docs/M8_PRICING_PLAN.md §5.
   */
  @ApiPropertyOptional({ type: DestinationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DestinationDto)
  destination?: DestinationDto;

  /**
   * A coupon code the shopper typed. Optional, and **never redeemed here** —
   * quoting is free and repeatable; the use is claimed once by `POST /orders`.
   */
  @ApiPropertyOptional({ example: 'SAVE10USES' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  couponCode?: string;

  /**
   * Set by orders-service so per-customer coupon limits can be checked. Guests
   * quoting from the cart page have no id, and simply do not get that check.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

// --- Response ------------------------------------------------------------

export class QuoteLineResponseDto {
  @ApiProperty() productId: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty() qty: number;
  @ApiProperty({ description: 'Integer minor units.' }) unitPriceMinor: number;
  @ApiProperty({ description: 'Integer minor units.' }) lineSubtotalMinor: number;
  @ApiProperty({ description: 'This line’s share of every discount that applied.' })
  lineDiscountMinor: number;
  @ApiProperty({ description: 'Subtotal less discount — what tax is charged on.' })
  taxableMinor: number;
  @ApiProperty({ description: 'Basis points: 725 is 7.25%.' }) taxRateBp: number;
  @ApiProperty({ description: 'This line’s share of its tax group’s single rounded figure.' })
  taxMinor: number;
}

export class TaxGroupResponseDto {
  @ApiProperty({ description: 'Basis points: 725 is 7.25%.' }) rateBp: number;
  @ApiProperty({ description: 'Whether the price already contained this tax.' })
  pricesIncludeTax: boolean;
  @ApiProperty({ description: 'Sum of the group’s taxable amounts, exact.' }) baseMinor: number;
  @ApiProperty({ description: 'Rounded exactly once, for the whole group.' }) taxMinor: number;
}

export class AppliedDiscountResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: 'Integer minor units.' }) amountMinor: number;
}

export class QuoteCouponResponseDto {
  @ApiProperty() code: string;
  @ApiProperty({ description: 'Whether it actually came off this basket.' }) applied: boolean;
  @ApiProperty({ description: 'Integer minor units.' }) amountMinor: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Why it did not apply: expired, exhausted, per_customer_limit, and so on.',
  })
  rejectedBecause?: string | null;
}

export class QuoteResponseDto {
  @ApiProperty() currency: string;
  @ApiProperty({ type: DestinationDto }) destination: DestinationDto;
  @ApiProperty({ type: [QuoteLineResponseDto] }) lines: QuoteLineResponseDto[];
  @ApiProperty({ description: 'Before any discount or tax.' }) subtotalMinor: number;
  @ApiProperty() discountMinor: number;
  @ApiProperty({ type: [AppliedDiscountResponseDto] })
  appliedDiscounts: AppliedDiscountResponseDto[];
  @ApiProperty({
    type: [TaxGroupResponseDto],
    description:
      'One entry per tax rate in the basket. Tax is rounded once per group, and this is that rounding made visible.',
  })
  taxBreakdown: TaxGroupResponseDto[];
  @ApiProperty() taxMinor: number;
  @ApiProperty({ description: 'The amount excluding tax.' }) netMinor: number;
  @ApiProperty({ description: 'What the customer pays.' }) totalMinor: number;
  @ApiPropertyOptional({ type: QuoteCouponResponseDto, nullable: true })
  coupon?: QuoteCouponResponseDto | null;
}
