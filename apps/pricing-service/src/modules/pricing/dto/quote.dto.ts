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
   * Which delivery service level to price in — 'standard', 'express'.
   *
   * Omitted, the **cheapest** available is used. A code that is not on offer
   * for this basket (express dropped out because the basket got heavier, and
   * the storefront still held the code) also falls back to the cheapest, and
   * the response says so via `shipping.requestedCodeUnavailable` rather than
   * failing the quote.
   */
  @ApiPropertyOptional({ example: 'standard' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  shippingRateCode?: string;

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

export class ShippingOptionResponseDto {
  @ApiProperty({ example: 'standard' }) code: string;
  @ApiProperty({ example: 'Standard (3–5 days)' }) name: string;
  @ApiProperty({ description: 'What this option costs this basket. Zero when free applied.' })
  costMinor: number;
  @ApiProperty({ description: 'True when a free-shipping threshold zeroed a real price.' })
  freeApplied: boolean;
  @ApiProperty({ description: 'The band price before any threshold.' }) listPriceMinor: number;
  @ApiProperty() currency: string;
}

export class QuoteShippingResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 'US-CA',
    description: 'Null when no zone covers this destination — the shop does not ship there.',
  })
  zone: string | null;

  @ApiProperty({ description: 'Summed from the basket’s product weights.' }) weightGrams: number;

  @ApiProperty({ type: [ShippingOptionResponseDto], description: 'Cheapest first.' })
  options: ShippingOptionResponseDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'The option folded into totalMinor. Cheapest, unless one was requested.',
  })
  selectedCode: string | null;

  @ApiProperty({
    description: 'True when a requested shippingRateCode is not on offer for this basket.',
  })
  requestedCodeUnavailable: boolean;
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
  @ApiProperty({
    description:
      'Delivery as charged, same convention as subtotalMinor — in an inclusive-tax region it already contains its VAT. Zero when free or unpriced.',
  })
  shippingMinor: number;
  @ApiProperty({
    description:
      'Delivery’s share of taxMinor: an allocation of its tax group’s single rounded figure, never rounded on its own.',
  })
  shippingTaxMinor: number;
  @ApiProperty({ description: 'The amount excluding tax.' }) netMinor: number;
  @ApiProperty({ description: 'What the customer pays. Includes shipping from M10.' })
  totalMinor: number;
  @ApiPropertyOptional({ type: QuoteCouponResponseDto, nullable: true })
  coupon?: QuoteCouponResponseDto | null;
  @ApiPropertyOptional({ type: QuoteShippingResponseDto, nullable: true })
  shipping?: QuoteShippingResponseDto | null;
}
