import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class GetRecommendationsQueryDto {
  @ApiPropertyOptional({
    default: 4,
    minimum: 1,
    maximum: 20,
    description: 'Maximum number of recommendation cards to return.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

export class RecommendedProductDto {
  @ApiProperty({ description: 'Catalog product UUID.' })
  productId: string;

  @ApiProperty({ example: 'TSH-BLK-M' })
  sku: string;

  @ApiProperty({ example: 'black-t-shirt-medium' })
  slug: string;

  @ApiProperty({ example: 'Black T-Shirt (M)' })
  name: string;

  @ApiProperty({ example: 1999, description: 'Integer minor units. 1999 = $19.99.' })
  priceMinor: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: 3, description: 'Co-purchase count in confirmed orders.' })
  coPurchaseCount: number;
}

export class RecommendationsResponseDto {
  @ApiProperty({ type: [RecommendedProductDto] })
  items: RecommendedProductDto[];

  @ApiProperty({ example: 4, description: 'Total enriched items returned.' })
  total: number;
}
