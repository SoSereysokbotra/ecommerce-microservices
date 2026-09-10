import { Module } from '@nestjs/common';
import { ShippingModule } from '../modules/shipping/shipping.module';
import { ShippingEventsListener } from './shipping-events.listener';

/**
 * The event side of shipping-service.
 *
 * Unlike cart-service (M7) and pricing-service (M9), which took the outbox
 * before they had anything to publish, both halves are used from the first
 * commit: `order.confirmed` creates a shipment, and the lifecycle publishes
 * `shipment.dispatched` / `shipment.delivered`.
 */
@Module({
  imports: [ShippingModule],
  providers: [ShippingEventsListener],
})
export class EventsModule {}
