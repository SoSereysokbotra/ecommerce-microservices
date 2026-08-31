import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  MinLength,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: 'TSH-BLK-M' })
  @IsString()
  @MinLength(1)
  sku: string;

  @ApiProperty({ example: 'black-t-shirt-medium' })
  @IsString()
  @MinLength(1)
  slug: string;

  @ApiProperty({ example: 'Black T-Shirt (M)' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsString()
  description?: string | null;

  @ApiProperty({ example: 1999, description: 'Integer minor units. 1999 = $19.99.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMinor: number;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3)
  currency: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: 'Integer minor units.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMinor?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListProductsQueryDto {
  @ApiPropertyOptional({ description: 'Category slug or id.' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ default: true, description: 'Omit to see only active products.' })
  @IsOptional()
  @Transform(({ value }) => value !== 'false' && value !== false)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ProductResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description?: string | null;
  @ApiProperty({ description: 'Integer minor units.' }) priceMinor: number;
  @ApiProperty() currency: string;
  @ApiPropertyOptional({ nullable: true }) categoryId?: string | null;
  @ApiProperty() active: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class PaginatedProductsDto {
  @ApiProperty({ type: [ProductResponseDto] })
  data: ProductResponseDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass as `cursor` to fetch the next page. Null on the last page.',
  })
  nextCursor?: string | null;
}
