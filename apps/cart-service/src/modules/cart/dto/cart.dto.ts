import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/**
 * An upper bound so a typo cannot park an absurd quantity in a cart. The real
 * limit is stock, checked when the order is placed; this only stops nonsense.
 */
const MAX_QTY = 999;

export class AddCartItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_QTY })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  qty: number;
}

export class SetCartItemQtyDto {
  @ApiProperty({ example: 2, minimum: 0, maximum: MAX_QTY, description: 'Zero removes the line.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  qty: number;
}

export class CartLineDto {
  @ApiProperty() productId: string;
  @ApiProperty() qty: number;
}

export class MergeAdjustmentDto {
  @ApiProperty() productId: string;
  @ApiProperty() requestedQty: number;
  @ApiProperty({ description: 'Zero means the line was dropped.' }) finalQty: number;
  @ApiProperty({ enum: ['capped_to_stock', 'out_of_stock', 'unavailable'] }) reason: string;
}

export class MergeSummaryDto {
  @ApiProperty({ type: [MergeAdjustmentDto] })
  adjustments: MergeAdjustmentDto[];
}

export class CartResponseDto {
  @ApiProperty({ type: [CartLineDto] })
  items: CartLineDto[];

  @ApiPropertyOptional({
    type: MergeSummaryDto,
    description:
      'Present only on the response that merged a guest cart in, so the UI can explain what changed.',
  })
  merged?: MergeSummaryDto;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'A new guest cart token to store, or null once the guest cart has been merged and the client should forget it.',
  })
  cartToken?: string | null;
}
