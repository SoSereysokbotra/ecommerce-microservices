import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, USER_ID_HEADER } from '@libs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto, OrderResponseDto } from './dto/order.dto';

@ApiTags('orders')
@ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Place an order' })
  @ApiOkResponse({ type: OrderResponseDto })
  create(
    @Headers(USER_ID_HEADER) customerId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: CreateOrderDto,
  ): Promise<OrderResponseDto> {
    return this.orders.create(this.requireCustomer(customerId), body, correlationId);
  }

  @Get()
  @ApiOperation({ summary: 'List my orders' })
  @ApiOkResponse({ type: [OrderResponseDto] })
  list(@Headers(USER_ID_HEADER) customerId: string): Promise<OrderResponseDto[]> {
    return this.orders.list(this.requireCustomer(customerId));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of my orders' })
  @ApiOkResponse({ type: OrderResponseDto })
  async findOne(
    @Headers(USER_ID_HEADER) customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    const order = await this.orders.findOne(id, this.requireCustomer(customerId));

    // Scoped by customer, so another customer's order is "not found" rather
    // than "forbidden" — the difference would leak that the order exists.
    if (!order) {
      throw new NotFoundException(`Order '${id}' not found`);
    }

    return order;
  }

  /**
   * Only the gateway can set this header; it strips any value a caller sends.
   * If it is missing the request did not come through the gateway.
   */
  private requireCustomer(customerId?: string): string {
    if (!customerId) {
      throw new BadRequestException(`Missing ${USER_ID_HEADER}; requests must go via the gateway`);
    }
    return customerId;
  }
}
