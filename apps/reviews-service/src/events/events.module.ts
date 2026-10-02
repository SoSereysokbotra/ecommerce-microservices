import { Module } from '@nestjs/common';
import { ReviewsModule } from '../modules/reviews/reviews.module';
import { OrderEventsListener } from './order-events.listener';

/**
 * The event side of reviews-service. `order.confirmed` in (the right to
 * review); `product.rating_changed` out, from step 3.
 */
@Module({
  imports: [ReviewsModule],
  providers: [OrderEventsListener],
})
export class EventsModule {}
