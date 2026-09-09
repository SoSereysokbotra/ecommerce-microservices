import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShippingZoneEntity } from './shipping-zone.entity';
import { ShippingRateEntity } from './shipping-rate.entity';
import { RatingInput, RatingResult, rate } from './rating';

/**
 * Reads the zone and rate tables and hands them to the pure rating rules.
 *
 * The split is deliberate and matches pricing-service: `rating.ts` decides,
 * this class fetches. Everything that can be subtly wrong lives in the half
 * that unit tests can reach without a database.
 *
 * **This service writes nothing.** Rating a basket is a read, exactly like
 * quoting one — a shopper changing their address on the checkout page rates
 * over and over, and a rate that created a shipment would create a shipment per
 * keystroke. Shipments are created by consuming `order.confirmed`, at step 7.
 */
@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    @InjectRepository(ShippingZoneEntity)
    private readonly zones: Repository<ShippingZoneEntity>,
    @InjectRepository(ShippingRateEntity)
    private readonly rates: Repository<ShippingRateEntity>,
  ) {}

  async rate(input: RatingInput): Promise<RatingResult> {
    /**
     * Both tables are read whole, and that is on purpose.
     *
     * There are four zones and ten rates. Filtering the zone in SQL would mean
     * expressing "empty array matches everything, null regions matches
     * everything, highest priority wins" as a query, and then the rule that
     * decides what a customer is charged would live half in Postgres and half
     * in TypeScript — with the half in Postgres unreachable from a unit test.
     *
     * If this table ever reaches a size where that matters, the fix is a cache,
     * not a cleverer query: rates change when someone edits them, which is
     * approximately never.
     */
    const [zones, rates] = await Promise.all([this.zones.find(), this.rates.find()]);

    const result = rate(zones, (zone) => rates.filter((r) => r.zoneId === zone.id), input);

    if (result.zone === null) {
      // Not an error — see `rate()` in rating.ts — but it does mean a customer
      // is being told the shop cannot deliver to them, which is worth a line in
      // the log if it turns out to be a gap in the seed rather than the truth.
      this.logger.warn(
        `No shipping zone covers ${input.destination.country}` +
          `${input.destination.region ? `-${input.destination.region}` : ''}`,
      );
    }

    return result;
  }

  /** Highest priority first — the order they are considered in. */
  listZones(): Promise<ShippingZoneEntity[]> {
    return this.zones.find({ order: { priority: 'DESC', code: 'ASC' } });
  }
}
