import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const SORTS = ['relevance', 'price_asc', 'price_desc'] as const;
export type Sort = (typeof SORTS)[number];

export class SearchProductsQueryDto {
  @ApiPropertyOptional({ example: 'tee', description: 'Free text over name and description.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ example: 'apparel', description: 'Category slug — the facet.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ example: 1000, description: 'Inclusive, integer minor units.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ example: 5000, description: 'Inclusive, integer minor units.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ enum: SORTS, default: 'relevance' })
  @IsOptional()
  @IsIn(SORTS)
  sort: Sort = 'relevance';

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class SearchHitDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ description: 'Base-currency price, integer minor units. Not converted.' })
  priceMinor: number;
  @ApiProperty() currency: string;
  @ApiProperty() exponent: number;
  @ApiProperty({ nullable: true, type: String }) categorySlug: string | null;
  @ApiProperty({ nullable: true, type: String }) categoryName: string | null;
  @ApiProperty() weightGrams: number;
  @ApiProperty() version: number;
  @ApiProperty() updatedAt: string;
}

export class CategoryFacetDto {
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty() count: number;
}

export class SearchFacetsDto {
  @ApiProperty({ type: [CategoryFacetDto] }) categories: CategoryFacetDto[];
}

export class SearchProductsResponseDto {
  @ApiProperty({ type: [SearchHitDto] }) hits: SearchHitDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty({ type: SearchFacetsDto }) facets: SearchFacetsDto;
}
