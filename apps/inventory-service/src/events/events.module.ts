import { Module } from '@nestjs/common';
import { StockModule } from '../modules/stock/stock.module';
import { InventoryEventsListener } from './inventory-events.listener';
import { ReservationExpiryJob } from './reservation-expiry.job';

@Module({
  imports: [StockModule],
  providers: [InventoryEventsListener, ReservationExpiryJob],
})
export class EventsModule {}
