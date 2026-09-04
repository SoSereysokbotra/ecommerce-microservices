import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, Public } from '@libs/common';
import { PricingService, QuoteView } from './pricing.service';
import { CreateQuoteDto, QuoteResponseDto } from './dto/quote.dto';
import { DiscountEntity } from './discount.entity';
import { TaxRateEntity } from './tax-rate.entity';

/**
 * Pricing needs no identity in M8. A quote is a function of the basket and the
 * destination, and the same basket costs the same whoever is holding it — so
 * nothing here reads `x-user-id`, and a guest gets the same answer as a signed
 * in shopper.
 *
 * The gateway still routes this through `@OptionalAuth()` rather than
 * `@Public()`, so an *invalid* token is rejected instead of being quietly
 * treated as anonymous, and so M9's per-customer coupons have an identity to
 * read when they arrive.
 */
@ApiTags('pricing')
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  /**
   * A POST that changes nothing, deliberately: a basket does not fit in a query
   * string. Answered with 200 rather than 201 because it creates no resource.
   */
  @Public()
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Price a basket: subtotal, discounts, tax, total' })
  @ApiOkResponse({ type: QuoteResponseDto })
  quote(
    @Body() body: CreateQuoteDto,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<QuoteView> {
    return this.pricing.quote(body, correlationId);
  }

  /** Feeds the storefront's region selector. */
  @Public()
  @Get('tax-rates')
  @ApiOperation({ summary: 'Every tax rule, most general first' })
  taxRates(): Promise<TaxRateEntity[]> {
    return this.pricing.listTaxRates();
  }

  @Public()
  @Get('discounts')
  @ApiOperation({ summary: 'Promotions currently active' })
  discounts(): Promise<DiscountEntity[]> {
    return this.pricing.listDiscounts();
  }
}
