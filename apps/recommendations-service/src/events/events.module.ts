import { Module } from '@nestjs/common';
import { RecommendationsModule } from '../modules/recommendations/recommendations.module';
import { OrderEventsListener } from './order-events.listener';

/**
 * Event consumer module for recommendations-service.
 * Wires OrderEventsListener to derive co-purchase pairs from `order.confirmed`.
 */
@Module({
  imports: [RecommendationsModule],
  providers: [OrderEventsListener],
  exports: [OrderEventsListener],
})
export class EventsModule {}
