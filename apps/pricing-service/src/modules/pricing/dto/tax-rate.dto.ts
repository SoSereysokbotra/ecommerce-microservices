import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateTaxRateDto {
  @ApiProperty({ example: 'US' })
  @IsString()
  @Length(2, 2)
  country: string;

  @ApiPropertyOptional({ example: 'CA' })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ example: 825, description: 'Basis points, e.g. 825 = 8.25%' })
  @IsInt()
  @Min(0)
  rateBp: number;

  @ApiProperty({ example: 'California Sales Tax' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  shippingTaxable?: boolean;
}
