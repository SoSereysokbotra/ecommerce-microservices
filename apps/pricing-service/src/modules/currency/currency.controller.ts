import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { CurrencyService } from './currency.service';
import { FxService } from './fx.service';
import { FxRateEntity } from './fx-rate.entity';
import { CurrencyEntity } from './currency.entity';
import { CurrencyResponseDto } from './dto/currency.dto';

/**
 * Feeds the storefront's currency switcher, and — more importantly — its
 * formatter. `formatMoney` divides by 100 today; from M11 it divides by
 * `10 ** exponent`, and the exponent comes from here rather than from a table
 * duplicated in the browser.
 */
@ApiTags('pricing')
@Controller('pricing')
export class CurrencyController {
  constructor(
    private readonly currencies: CurrencyService,
    private readonly fx: FxService,
  ) {}

  @Public()
  @Get('currencies')
  @ApiOperation({ summary: 'Every currency on offer, with its minor-unit exponent' })
  @ApiOkResponse({ type: [CurrencyResponseDto] })
  list(): Promise<CurrencyEntity[]> {
    return this.currencies.list();
  }

  /**
   * The rates currently in force, newest per pair.
   *
   * The equivalent of `GET /pricing/tax-rates` and `/shipping/zones`, and for
   * the same reason: a rule you cannot read is a rule you cannot debug, and
   * "why is this basket €18.49" is a question somebody will ask.
   */
  @Public()
  @Get('fx-rates')
  @ApiOperation({ summary: 'The exchange rate in force for each pair' })
  rates(): Promise<FxRateEntity[]> {
    return this.fx.current();
  }
}
