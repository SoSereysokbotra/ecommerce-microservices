import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { CurrencyService } from './currency.service';
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
  constructor(private readonly currencies: CurrencyService) {}

  @Public()
  @Get('currencies')
  @ApiOperation({ summary: 'Every currency on offer, with its minor-unit exponent' })
  @ApiOkResponse({ type: [CurrencyResponseDto] })
  list(): Promise<CurrencyEntity[]> {
    return this.currencies.list();
  }
}
