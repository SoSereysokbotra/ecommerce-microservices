import { Module } from '@nestjs/common';
import { PaymentsModule } from '../modules/payments/payments.module';
import { PaymentEventsListener } from './payment-events.listener';

@Module({
  imports: [PaymentsModule],
  providers: [PaymentEventsListener],
})
export class EventsModule {}
