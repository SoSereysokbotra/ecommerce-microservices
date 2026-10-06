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
  ValidationArguments,
  ValidationOptions,
  isUUID,
  registerDecorator,
} from 'class-validator';

export function IsCommaSeparatedUUIDs(maxCount = 50, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCommaSeparatedUUIDs',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const trimmed = value.trim();
          if (!trimmed) return false;
          const parts = trimmed
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          if (parts.length === 0 || parts.length > maxCount) return false;
          return parts.every((id) => isUUID(id));
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a comma-separated list of up to ${maxCount} valid UUIDs`;
        },
      },
    });
  };
}

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

  @ApiPropertyOptional({ default: 0, description: 'Shipping weight in grams. Integer.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  weightGrams?: number;

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

  @ApiPropertyOptional({ description: 'Shipping weight in grams. Integer.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  weightGrams?: number;

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
  @ApiPropertyOptional({
    description:
      'Comma-separated product UUIDs (up to 50). When provided, returns only matching products and ignores category, cursor and pagination.',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6,c3d4e5f6-a7b8-1234-5678-9abcdef01234',
  })
  @IsOptional()
  @IsString()
  @IsCommaSeparatedUUIDs(50)
  ids?: string;

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
  @ApiProperty({ description: 'Shipping weight in grams. Zero until someone weighs it.' })
  weightGrams: number;
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
