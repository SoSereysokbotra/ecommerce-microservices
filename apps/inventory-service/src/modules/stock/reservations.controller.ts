import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StockService } from './stock.service';
import { ReservationResultDto, ReserveStockDto } from './dto/stock.dto';

/**
 * Reserving is an inventory operation, not an edit to a stock row, so it gets
 * its own resource. M5 grows this into a real reservations table with an order
 * id and an expiry; today it only moves quantities between available and
 * reserved on the stock row.
 */
@ApiTags('inventory')
@Controller('inventory/reservations')
export class ReservationsController {
  constructor(private readonly stock: StockService) {}

  /**
   * Called synchronously by orders-service during checkout (M2). From M3 this
   * is driven by an `order.created` event instead.
   */
  @Post()
  @ApiOperation({ summary: 'Reserve stock for an order' })
  @ApiOkResponse({ type: ReservationResultDto })
  async reserve(@Body() body: ReserveStockDto): Promise<ReservationResultDto> {
    const stock = await this.stock.reserve(body.items);
    return { orderId: body.orderId, stock };
  }
}
