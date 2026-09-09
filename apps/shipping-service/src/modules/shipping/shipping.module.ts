import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RatesController } from './rates.controller';
import { ShippingService } from './shipping.service';
import { ShippingRateEntity } from './shipping-rate.entity';
import { ShippingZoneEntity } from './shipping-zone.entity';

/**
 * Step 3 of M10: rating only. Nothing is exported yet — the shipment lifecycle
 * and the `order.confirmed` consumer arrive at step 7 and will need
 * `ShippingService`, at which point this gains an `exports`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ShippingZoneEntity, ShippingRateEntity])],
  controllers: [RatesController],
  providers: [ShippingService],
})
export class ShippingModule {}
