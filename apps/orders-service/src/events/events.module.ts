import { Module } from '@nestjs/common';
import { OrdersModule } from '../modules/orders/orders.module';
import { OrderEventsListener } from './order-events.listener';

@Module({
  imports: [OrdersModule],
  providers: [OrderEventsListener],
})
export class EventsModule {}
