import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CatalogClient } from './catalog.client';
import { CouponsService, type CouponRejection } from '../coupons/coupons.service';
import { DiscountEntity } from './discount.entity';
import { TaxRateEntity } from './tax-rate.entity';
import { CreateQuoteDto } from './dto/quote.dto';
import {
  computeQuote,
  type Destination,
  type DiscountRule,
  type QuoteLineInput,
  type TaxRule,
} from './quote';

/** What a coupon code did to this basket, and if nothing, why. */
export interface QuoteCoupon {
  code: string;
  applied: boolean;
  amountMinor: number;
  rejectedBecause: CouponRejection | null;
}

/** A quote, with the presentation fields the calculator deliberately ignores. */
export interface QuoteView extends ReturnType<typeof computeQuote> {
  lines: (ReturnType<typeof computeQuote>['lines'][number] & { sku: string; name: string })[];
  coupon: QuoteCoupon | null;
}

/**
 * Everything around the arithmetic: reading the rules, reading the prices, and
 * putting names back on the result.
 *
 * The arithmetic itself is in quote.ts and has no idea this class exists. That
 * split is the point — the part with decisions in it is a pure function, and
 * this part is plumbing that can be read quickly and dismissed.
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    @InjectRepository(TaxRateEntity) private readonly taxRates: Repository<TaxRateEntity>,
    @InjectRepository(DiscountEntity) private readonly discounts: Repository<DiscountEntity>,
    private readonly catalog: CatalogClient,
    private readonly config: ConfigService,
    private readonly coupons: CouponsService,
  ) {}

  async quote(input: CreateQuoteDto, correlationId?: string): Promise<QuoteView> {
    const destination = this.destinationFor(input);

    const products = await this.catalog.pricedProducts(
      input.items.map((i) => i.productId),
      correlationId,
    );

    const lines: QuoteLineInput[] = input.items.map((item) => {
      // pricedProducts throws on anything missing, so this cannot be undefined.
      const product = products.get(item.productId)!;
      return {
        productId: product.id,
        qty: item.qty,
        unitPriceMinor: product.priceMinor,
        category: product.category,
      };
    });

    // Only this country's rules. The resolver picks the most specific match
    // among them, so narrowing further here would be doing its job badly.
    //
    // `code: IsNull()` is load-bearing: a coupon's discount row lives in the
    // same table, and without this filter every coupon would apply to everyone
    // automatically — a discount nobody had to ask for, which is the one thing
    // a coupon is not.
    const [taxRules, discounts] = await Promise.all([
      this.taxRates.find({ where: { country: destination.country } }),
      this.discounts.find({ where: { active: true, code: IsNull() } }),
    ]);

    const currency = [...products.values()][0]?.currency ?? 'USD';

    /**
     * A coupon, if one was typed.
     *
     * **Quoting never redeems.** The cart page re-quotes on every quantity
     * change, so a quote that consumed a use would empty a ten-use coupon by
     * browsing. The use is claimed later, once by `POST /orders`, through
     * `CouponsService.hold`.
     *
     * A code that is refused does not fail the quote: the basket still has a
     * price, and the shopper needs to see it alongside the reason their code
     * did not apply.
     */
    let coupon: { code: string; discount: DiscountRule } | null = null;
    let couponRejection: CouponRejection | null = null;

    if (input.couponCode) {
      const resolved = await this.coupons.resolve(input.couponCode, input.customerId);
      if (resolved.ok) {
        coupon = { code: resolved.coupon.code, discount: toDiscountRule(resolved.discount) };
      } else {
        couponRejection = resolved.reason;
      }
    }

    const quote = computeQuote({
      currency,
      destination,
      lines,
      taxRules: taxRules.map(toTaxRule),
      discounts: [...discounts.map(toDiscountRule), ...(coupon ? [coupon.discount] : [])],
      // Read once, here, and passed in — so the calculator stays a pure
      // function of its arguments and promotion windows are testable.
      now: new Date(),
    });

    this.logger.log(
      `Quoted ${lines.length} line(s) for ${destination.country}` +
        `${destination.region ? `-${destination.region}` : ''}: ` +
        `subtotal ${quote.subtotalMinor}, discount ${quote.discountMinor}, ` +
        `tax ${quote.taxMinor}, total ${quote.totalMinor} [${correlationId ?? '-'}]`,
    );

    return {
      ...quote,
      lines: quote.lines.map((line) => {
        const product = products.get(line.productId)!;
        return { ...line, sku: product.sku, name: product.name };
      }),
      // What the shopper needs to know about the code they typed: whether it
      // applied, what it took off, and if not, *why* not. "Invalid code" for
      // every case is the version people complain about.
      coupon: input.couponCode
        ? {
            code: input.couponCode.trim().toUpperCase(),
            applied: coupon !== null,
            amountMinor: coupon
              ? (quote.appliedDiscounts.find((d) => d.id === coupon.discount.id)?.amountMinor ?? 0)
              : 0,
            rejectedBecause: couponRejection,
          }
        : null,
    };
  }

  listTaxRates(): Promise<TaxRateEntity[]> {
    return this.taxRates.find({ order: { country: 'ASC', region: 'ASC', category: 'ASC' } });
  }

  listDiscounts(): Promise<DiscountEntity[]> {
    return this.discounts.find({ where: { active: true }, order: { name: 'ASC' } });
  }

  private destinationFor(input: CreateQuoteDto): Destination {
    if (input.destination) {
      return {
        country: input.destination.country.toUpperCase(),
        region: input.destination.region?.toUpperCase() || null,
      };
    }

    return {
      country: (this.config.get<string>('defaultTaxCountry') ?? 'US').toUpperCase(),
      region: (this.config.get<string>('defaultTaxRegion') || '').toUpperCase() || null,
    };
  }
}

function toTaxRule(row: TaxRateEntity): TaxRule {
  return {
    country: row.country,
    region: row.region,
    category: row.category,
    rateBp: row.rateBp,
    pricesIncludeTax: row.pricesIncludeTax,
    name: row.name,
  };
}

function toDiscountRule(row: DiscountEntity): DiscountRule {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    valueBp: row.valueBp,
    valueMinor: row.valueMinor,
    scope: row.scope,
    scopeRef: row.scopeRef,
    minSubtotalMinor: row.minSubtotalMinor,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    active: row.active,
  };
}
