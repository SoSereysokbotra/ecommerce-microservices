import { Module } from '@nestjs/common';
import { StockModule } from '../modules/stock/stock.module';
import { InventoryEventsListener } from './inventory-events.listener';

@Module({
  imports: [StockModule],
  providers: [InventoryEventsListener],
})
export class EventsModule {}
