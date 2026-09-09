import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class RateDestinationDto {
  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2.' })
  @IsString()
  @Length(2, 2)
  country: string;

  @ApiPropertyOptional({ example: 'CA', description: 'State or province code.' })
  @IsOptional()
  @IsString()
  @Length(1, 16)
  region?: string;
}

export class RateRequestDto {
  /**
   * `@IsNotEmptyObject` is not decoration. `@ValidateNested()` alone passes when
   * the value is **undefined**, so a request with no destination reached the
   * controller, dereferenced `body.destination.country` and came back 500 — a
   * malformed request reported as a server fault, which tells the caller to
   * retry something that will never work. Same category as the 503-vs-400 fix
   * in `CatalogClient` (HANDOFF §7): say whose fault it is, accurately.
   */
  @ApiProperty({ type: RateDestinationDto })
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => RateDestinationDto)
  destination: RateDestinationDto;

  /**
   * Zero is valid, not missing. Every catalog product's `weight_grams` defaults
   * to 0, so a basket of products nobody has weighed yet must still rate — into
   * the lightest band — rather than being rejected.
   */
  @ApiProperty({ example: 1200, description: 'Total basket weight in grams. Zero is valid.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  weightGrams: number;

  /**
   * The **discounted** subtotal — what the customer is actually spending.
   * Free-shipping thresholds are compared against this, not the sticker total.
   */
  @ApiProperty({ example: 4999, description: 'Discounted subtotal, integer minor units.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  subtotalMinor: number;
}

export class RateOptionDto {
  @ApiProperty({ example: 'standard' }) code: string;
  @ApiProperty({ example: 'Standard (3–5 days)' }) name: string;
  @ApiProperty({ description: 'What this costs for this basket. Zero when free applied.' })
  costMinor: number;
  @ApiProperty({ description: 'True when a free-shipping threshold zeroed a real price.' })
  freeApplied: boolean;
  @ApiProperty({ description: 'The band price before any threshold — for showing “was $5.99”.' })
  listPriceMinor: number;
  @ApiProperty({ example: 'USD' }) currency: string;
}

export class RateResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 'US-CA',
    description: 'Null when no zone covers this destination — the shop does not ship there.',
  })
  zone: string | null;

  @ApiProperty() weightGrams: number;

  @ApiProperty({
    type: [RateOptionDto],
    description: 'Cheapest first, ties by code. Empty when nothing ships to this destination.',
  })
  options: RateOptionDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'What applies when the caller names no service level. Null when none do.',
  })
  cheapestCode: string | null;
}
