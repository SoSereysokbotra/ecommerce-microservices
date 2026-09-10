import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RatesController } from './rates.controller';
import { ShipmentsController } from './shipments.controller';
import { ShippingService } from './shipping.service';
import { ShipmentsService } from './shipments.service';
import { ShipmentEntity } from './shipment.entity';
import { ShippingRateEntity } from './shipping-rate.entity';
import { ShippingZoneEntity } from './shipping-zone.entity';

/**
 * `ShipmentsService` is exported because the `order.confirmed` consumer in
 * `events/` creates shipments through it — the same shape pricing's
 * `CouponsModule` took in M9.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ShippingZoneEntity, ShippingRateEntity, ShipmentEntity])],
  controllers: [RatesController, ShipmentsController],
  providers: [ShippingService, ShipmentsService],
  exports: [ShipmentsService],
})
export class ShippingModule {}
