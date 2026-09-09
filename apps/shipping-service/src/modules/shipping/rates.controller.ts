import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { ShippingService } from './shipping.service';
import { RateRequestDto, RateResponseDto } from './dto/rate.dto';
import { RatingResult } from './rating';
import { ShippingZoneEntity } from './shipping-zone.entity';

/**
 * What a basket costs to deliver.
 *
 * Called by **pricing-service**, not by the browser. Shipping cost changes the
 * order total, and M8 established that exactly one thing computes a total — so
 * the rate is folded into `POST /pricing/quote` rather than added to it
 * afterwards by whoever happens to be holding both numbers. See
 * docs/M10_SHIPPING_PLAN.md §4.
 *
 * That is also why there is no `@OptionalAuth()` route for guests here: a guest
 * sees shipping through the quote, which already works signed out.
 */
@ApiTags('shipping')
@Controller('shipping')
export class RatesController {
  constructor(private readonly shipping: ShippingService) {}

  /**
   * A POST that writes nothing, for the same reason `POST /pricing/quote` is
   * one: a destination and a weight do not fit in a query string. 200, not 201
   * — no resource is created.
   *
   * **Rating must never create a shipment.** The checkout page rates on every
   * address change; a rate that wrote something would create a shipment per
   * keystroke. It is the same asymmetry M9 drew between quoting a coupon and
   * redeeming one.
   */
  @Public()
  @Post('rates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Price delivery of a basket by weight and destination' })
  @ApiOkResponse({ type: RateResponseDto })
  rates(@Body() body: RateRequestDto): Promise<RatingResult> {
    return this.shipping.rate({
      destination: { country: body.destination.country, region: body.destination.region ?? null },
      weightGrams: body.weightGrams,
      subtotalMinor: body.subtotalMinor,
    });
  }

  /**
   * Every zone, for whoever is working out why a destination priced the way it
   * did. The equivalent of pricing's `GET /pricing/tax-rates`, and the reason
   * that endpoint exists: a rule you cannot read is a rule you cannot debug.
   */
  @Public()
  @Get('zones')
  @ApiOperation({ summary: 'Every shipping zone, highest priority first' })
  zones(): Promise<ShippingZoneEntity[]> {
    return this.shipping.listZones();
  }
}
