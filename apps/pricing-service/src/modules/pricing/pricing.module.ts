import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogClient } from './catalog.client';
import { DiscountEntity } from './discount.entity';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';
import { TaxRateEntity } from './tax-rate.entity';

/**
 * Step 3 of M8. Note there is nothing to export: no other module in this
 * service consumes pricing, because there are no other modules — no events, no
 * jobs, no consumers. See app.module.ts for why that is deliberate.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TaxRateEntity, DiscountEntity])],
  controllers: [PricingController],
  providers: [PricingService, CatalogClient],
})
export class PricingModule {}
