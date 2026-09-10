import { ApiProperty } from '@nestjs/swagger';

export class CurrencyResponseDto {
  @ApiProperty({ example: 'JPY', description: 'ISO 4217, upper case.' })
  code: string;

  @ApiProperty({
    example: 0,
    description:
      'Decimal places: 10^exponent minor units to one major unit. Two for USD and EUR, ZERO for JPY — which is why this is data and not a constant.',
  })
  exponent: number;

  @ApiProperty({ example: 'Japanese Yen' })
  name: string;
}
