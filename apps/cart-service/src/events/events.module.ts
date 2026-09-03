import { Module } from '@nestjs/common';
import { CartModule } from '../modules/cart/cart.module';
import { CartEventsListener } from './cart-events.listener';

@Module({
  imports: [CartModule],
  providers: [CartEventsListener],
})
export class EventsModule {}
