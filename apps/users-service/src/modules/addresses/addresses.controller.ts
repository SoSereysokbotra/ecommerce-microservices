import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, USER_ID_HEADER } from '@libs/common';
import { AddressesService } from './addresses.service';
import { AddressEntity } from './address.entity';
import { AddressResponseDto, CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * A customer's saved delivery addresses.
 *
 * ## Why `@Public()` on routes that are anything but public
 *
 * Identity arrives as `x-user-id`, set by the gateway from the JWT it verified
 * — and the gateway **deletes** any `x-user-id` the caller sent before writing
 * its own (`ProxyService.forward`), so the header cannot be spoofed from
 * outside. That is the same way orders-service and cart-service have
 * established who is calling since M3.
 *
 * `@Public()` is what lets **orders-service** read an address at checkout: it
 * calls in over the Docker network holding the customer id the gateway gave it,
 * but not the customer's bearer token. The gateway's own `/users/*` route stays
 * guarded, so nothing reaches here from a browser without a valid JWT.
 *
 * This rests on the project's standing assumption that nothing but the gateway
 * is reachable from outside (HANDOFF §3). It is the same assumption cart's and
 * inventory's internal calls already make.
 */
@ApiTags('addresses')
@ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
@Controller('users/me/addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'My saved addresses, default first' })
  @ApiOkResponse({ type: [AddressResponseDto] })
  list(@Headers(USER_ID_HEADER) userId: string): Promise<AddressEntity[]> {
    return this.addresses.list(this.requireUser(userId));
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'One of my addresses' })
  @ApiOkResponse({ type: AddressResponseDto })
  findOne(
    @Headers(USER_ID_HEADER) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddressEntity> {
    // Somebody else's address id is a 404, not a 403 — see AddressesService.
    return this.addresses.findOne(this.requireUser(userId), id);
  }

  @Public()
  @Post()
  @ApiOperation({ summary: 'Save an address' })
  @ApiOkResponse({ type: AddressResponseDto })
  create(
    @Headers(USER_ID_HEADER) userId: string,
    @Body() body: CreateAddressDto,
  ): Promise<AddressEntity> {
    return this.addresses.create(this.requireUser(userId), body);
  }

  @Public()
  @Patch(':id')
  @ApiOperation({ summary: 'Edit an address' })
  @ApiOkResponse({ type: AddressResponseDto })
  update(
    @Headers(USER_ID_HEADER) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAddressDto,
  ): Promise<AddressEntity> {
    return this.addresses.update(this.requireUser(userId), id, body);
  }

  @Public()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an address' })
  remove(
    @Headers(USER_ID_HEADER) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.addresses.remove(this.requireUser(userId), id);
  }

  /**
   * No identity means the gateway did not put one there, which means this was
   * not reached through the gateway. Refuse rather than guessing.
   */
  private requireUser(userId: string): string {
    if (!userId) {
      throw new BadRequestException(`${USER_ID_HEADER} is required`);
    }
    return userId;
  }
}
