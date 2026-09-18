import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Name and description only. **The slug is immutable**, the way a product's
 * `sku` is: it is the facet key in search and the value in every product
 * document's `categorySlug`, and a URL people may have bookmarked. Renaming
 * a category changes what it is called, not what it is.
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'Clothing' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class CategoryResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description?: string | null;
  @ApiProperty({ description: 'Bumped on every write; carried on category.updated.' })
  version: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
