import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Home' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  label?: string | null;

  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @MinLength(1)
  recipient: string;

  @ApiProperty({ example: '12 Ocean Avenue' })
  @IsString()
  @MinLength(1)
  line1: string;

  @ApiPropertyOptional({ example: 'Apt 4' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  line2?: string | null;

  @ApiProperty({ example: 'San Francisco' })
  @IsString()
  @MinLength(1)
  city: string;

  /**
   * Upper-cased on the way in, because the tax rules and shipping zones compare
   * these exactly. A shopper who types `ca` must get Californian tax, not the
   * national fallback — and the alternative, lower-casing every comparison at
   * every call site, is the version that eventually misses one.
   */
  @ApiPropertyOptional({ example: 'CA', description: 'State or province code.' })
  @IsOptional()
  @Transform(({ value }) => (trimOrNull({ value }) === null ? null : upper({ value })))
  @IsString()
  @Length(1, 16)
  region?: string | null;

  @ApiPropertyOptional({ example: '94102' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  postcode?: string | null;

  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2.' })
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'country must be a two-letter ISO 3166-1 alpha-2 code' })
  country: string;

  @ApiPropertyOptional({ example: '+1 415 555 0123' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  phone?: string | null;

  @ApiPropertyOptional({ default: false, description: 'Make this the one checkout pre-selects.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** Every field optional; anything omitted is left as it was. */
export class UpdateAddressDto extends CreateAddressDto {
  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  declare recipient: string;

  @ApiPropertyOptional({ example: '12 Ocean Avenue' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  declare line1: string;

  @ApiPropertyOptional({ example: 'San Francisco' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  declare city: string;

  @ApiPropertyOptional({ example: 'US', description: 'ISO 3166-1 alpha-2.' })
  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'country must be a two-letter ISO 3166-1 alpha-2 code' })
  declare country: string;
}

export class AddressResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiPropertyOptional({ nullable: true }) label: string | null;
  @ApiProperty() recipient: string;
  @ApiProperty() line1: string;
  @ApiPropertyOptional({ nullable: true }) line2: string | null;
  @ApiProperty() city: string;
  @ApiPropertyOptional({ nullable: true }) region: string | null;
  @ApiPropertyOptional({ nullable: true }) postcode: string | null;
  @ApiProperty() country: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiProperty() isDefault: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
