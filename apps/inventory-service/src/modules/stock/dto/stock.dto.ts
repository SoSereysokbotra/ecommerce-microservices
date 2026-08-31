import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';

export class ListStockQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated product ids. Omit to list all stock rows.',
    example: 'a1b2...,c3d4...',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v: string) => v.trim())
          .filter(Boolean)
      : value,
  )
  productIds?: string[];
}

export class AdjustStockDto {
  @ApiProperty({
    description: 'Signed change to available quantity. Negative removes stock.',
    example: 25,
  })
  @Type(() => Number)
  @IsInt()
  @NotEquals(0, { message: 'delta must not be zero' })
  delta: number;

  @ApiProperty({ example: 'stock-take correction' })
  @IsString()
  @MaxLength(200)
  reason: string;
}

export class SetStockDto {
  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  availableQty: number;
}

export class StockResponseDto {
  @ApiProperty() productId: string;
  @ApiProperty({ description: 'Units that can still be reserved.' }) availableQty: number;
  @ApiProperty({ description: 'Units held by in-flight orders.' }) reservedQty: number;
  @ApiProperty() version: number;
  @ApiProperty() updatedAt: Date;
}

export class ReservationItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;
}

export class ReserveStockDto {
  @ApiProperty()
  @IsUUID()
  orderId: string;

  @ApiProperty({ type: [ReservationItemDto] })
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  @ArrayMinSize(1)
  items: ReservationItemDto[];
}

export class ReservationResultDto {
  @ApiProperty() orderId: string;
  @ApiProperty({ type: [StockResponseDto] }) stock: StockResponseDto[];
}
