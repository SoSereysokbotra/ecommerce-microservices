import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CurrencyController } from './currency.controller';
import { CurrencyService } from './currency.service';
import { CurrencyEntity } from './currency.entity';
import { FxRateEntity } from './fx-rate.entity';
import { FxService } from './fx.service';

/**
 * The exponent and the rates. Both services are exported because step 4's
 * quoting needs them — `FxService` to get the rate, `CurrencyService` to get
 * the exponents that go with it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CurrencyEntity, FxRateEntity])],
  controllers: [CurrencyController],
  providers: [CurrencyService, FxService],
  exports: [CurrencyService, FxService],
})
export class CurrencyModule {}
