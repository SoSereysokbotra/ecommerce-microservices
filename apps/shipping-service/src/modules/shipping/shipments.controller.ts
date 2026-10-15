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
import { Roles, USER_ID_HEADER, USER_ROLE_HEADER, UserRole } from '@libs/common';
import { ShipmentsService } from './shipments.service';
import { ShipmentEntity } from './shipment.entity';
import { DispatchShipmentDto, ShipmentResponseDto } from './dto/shipment.dto';

/**
 * Reading a delivery, and moving it along.
 *
 * The two write endpoints are **staff actions**, protected in M16 by @Roles(ADMIN, STAFF).
 * findByOrder is scoped to customer, with staff/admin override.
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
    @Headers(USER_ROLE_HEADER) callerRole: string | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ShipmentEntity> {
    const isStaffOrAdmin = callerRole === UserRole.ADMIN || callerRole === UserRole.STAFF;
    const shipment = isStaffOrAdmin
      ? await this.shipments.findByOrderForStaff(orderId)
      : await this.shipments.findByOrder(orderId, this.requireCustomer(customerId));

    if (!shipment) {
      // Also what somebody else's order looks like from here. A confirmed order
      // has a shipment within seconds; before that this is a legitimate 404.
      throw new NotFoundException(`No shipment for order '${orderId}'`);
    }
    return shipment;
  }

  @Post(':id/dispatch')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Hand a parcel to the carrier (staff)' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  async dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DispatchShipmentDto,
  ): Promise<ShipmentEntity> {
    return this.shipments.dispatch(id, body);
  }

  @Post(':id/deliver')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Mark a parcel delivered (staff)' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  async deliver(@Param('id', ParseUUIDPipe) id: string): Promise<ShipmentEntity> {
    return this.shipments.deliver(id);
  }

  private requireCustomer(customerId: string): string {
    if (!customerId) {
      throw new BadRequestException(`${USER_ID_HEADER} is required`);
    }
    return customerId;
  }
}

