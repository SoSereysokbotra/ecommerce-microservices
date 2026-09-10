import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CurrencyController } from './currency.controller';
import { CurrencyService } from './currency.service';
import { CurrencyEntity } from './currency.entity';

/**
 * Step 1 of M11: the exponent, written down. `CurrencyService` is exported
 * because step 2's `FxService` and step 4's quoting both need it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CurrencyEntity])],
  controllers: [CurrencyController],
  providers: [CurrencyService],
  exports: [CurrencyService],
})
export class CurrencyModule {}
