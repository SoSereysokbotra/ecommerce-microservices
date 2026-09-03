import { Module } from '@nestjs/common';
import { CartModule } from '../modules/cart/cart.module';
import { CartEventsListener } from './cart-events.listener';
import { CartAbandonmentJob } from './cart-abandonment.job';

@Module({
  imports: [CartModule],
  providers: [CartEventsListener, CartAbandonmentJob],
  exports: [CartAbandonmentJob],
})
export class EventsModule {}
