import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { OrderStatus } from '../order.entity';

export class OrderLineDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderLineDto] })
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  @ArrayMinSize(1)
  items: OrderLineDto[];
}

export class OrderItemResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() productId: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty() qty: number;
  @ApiProperty({ description: 'Integer minor units.' }) unitPriceMinor: number;
}

export class OrderResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() customerId: string;
  @ApiProperty({ enum: OrderStatus }) status: OrderStatus;
  @ApiProperty() currency: string;
  @ApiProperty({ description: 'Integer minor units.' }) totalMinor: number;
  @ApiPropertyOptional({ nullable: true }) failureReason?: string | null;
  @ApiProperty({ type: [OrderItemResponseDto] }) items: OrderItemResponseDto[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
