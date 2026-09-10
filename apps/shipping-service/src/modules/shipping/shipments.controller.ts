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
import { USER_ID_HEADER } from '@libs/common';
import { ShipmentsService } from './shipments.service';
import { ShipmentEntity } from './shipment.entity';
import { DispatchShipmentDto, ShipmentResponseDto } from './dto/shipment.dto';

/**
 * Reading a delivery, and moving it along.
 *
 * The two write endpoints are **staff actions**, and there are no roles until
 * M16 — so they are protected by nothing but a valid JWT, exactly like "create
 * product" and "adjust stock" have been since M1 (HANDOFF §9). That is not new
 * debt, but it is two more endpoints on the pile, and the M16 entry should say
 * so. Anyone with an account can currently mark any parcel delivered.
 */
@ApiTags('shipments')
@ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
@Controller('shipping/shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  /**
   * Keyed by **order** id, not shipment id: the order page is the only thing
   * that asks, and it knows the order. One shipment per order makes that
   * unambiguous.
   */
  @Get(':orderId')
  @ApiOperation({ summary: 'The delivery for one of my orders' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  async findByOrder(
    @Headers(USER_ID_HEADER) customerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ShipmentEntity> {
    const shipment = await this.shipments.findByOrder(orderId, this.requireCustomer(customerId));

    if (!shipment) {
      // Also what somebody else's order looks like from here. A confirmed order
      // has a shipment within seconds; before that this is a legitimate 404.
      throw new NotFoundException(`No shipment for order '${orderId}'`);
    }
    return shipment;
  }

  @Post(':id/dispatch')
  @ApiOperation({ summary: 'Hand a parcel to the carrier (staff)' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DispatchShipmentDto,
  ): Promise<ShipmentEntity> {
    return this.shipments.dispatch(id, body);
  }

  @Post(':id/deliver')
  @ApiOperation({ summary: 'Mark a parcel delivered (staff)' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  deliver(@Param('id', ParseUUIDPipe) id: string): Promise<ShipmentEntity> {
    return this.shipments.deliver(id);
  }

  private requireCustomer(customerId: string): string {
    if (!customerId) {
      throw new BadRequestException(`${USER_ID_HEADER} is required`);
    }
    return customerId;
  }
}
