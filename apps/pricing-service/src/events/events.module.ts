import { Module } from '@nestjs/common';
import { CouponsModule } from '../modules/coupons/coupons.module';
import { PricingEventsListener } from './pricing-events.listener';

/**
 * The event side of pricing-service, added in M9.
 *
 * M8 shipped this service with no events at all and said so out loud, because a
 * quote changes no state. A coupon redemption does, and it has to be given back
 * when its order is cancelled — so the wiring arrives now rather than being
 * carried around unused, which is what ADR-0007 said would happen.
 */
@Module({
  imports: [CouponsModule],
  providers: [PricingEventsListener],
})
export class EventsModule {}
