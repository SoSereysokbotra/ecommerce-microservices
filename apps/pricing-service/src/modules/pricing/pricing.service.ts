import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CatalogClient } from './catalog.client';
import { ShippingClient, type ShippingOption } from './shipping.client';
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

/** What delivery options this basket has, and which one is priced into the total. */
export interface QuoteShipping {
  /** Null when no zone covers the destination — the shop does not ship there. */
  zone: string | null;
  weightGrams: number;
  /** Every service level, cheapest first. The storefront's rate picker. */
  options: ShippingOption[];
  /** The one folded into `totalMinor`. Null when nothing ships there. */
  selectedCode: string | null;
  /** True when the caller named a code that is not on offer for this basket. */
  requestedCodeUnavailable: boolean;
}

/** A quote, with the presentation fields the calculator deliberately ignores. */
export interface QuoteView extends ReturnType<typeof computeQuote> {
  lines: (ReturnType<typeof computeQuote>['lines'][number] & { sku: string; name: string })[];
  coupon: QuoteCoupon | null;
  shipping: QuoteShipping | null;
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
    private readonly shipping: ShippingClient,
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

    const priceable = {
      currency,
      destination,
      lines,
      taxRules: taxRules.map(toTaxRule),
      discounts: [...discounts.map(toDiscountRule), ...(coupon ? [coupon.discount] : [])],
      // Read once, here, and passed in — so the calculator stays a pure
      // function of its arguments and promotion windows are testable.
      now: new Date(),
    };

    /**
     * Priced twice, deliberately.
     *
     * A free-shipping threshold is measured against the **discounted**
     * subtotal — what the shopper is actually spending — and that number does
     * not exist until the promotions have been applied. So: price the goods,
     * ask shipping what delivery costs for that basket, then price again with
     * the answer folded in.
     *
     * There is no fixpoint to worry about. Shipping cost never feeds back into
     * the discounts: order-level promotions allocate across line subtotals and
     * `minSubtotalMinor` is checked against the goods subtotal, neither of which
     * the second pass changes. The first pass's `discountMinor` is final.
     *
     * `computeQuote` is a pure function over a dozen lines of integer
     * arithmetic, so the second pass costs nothing worth optimising — and it is
     * skipped entirely when delivery is free or unpriced.
     */
    const goodsOnly = computeQuote(priceable);

    const shipping = await this.shippingFor(
      input,
      destination,
      lines,
      products,
      goodsOnly.subtotalMinor - goodsOnly.discountMinor,
      correlationId,
    );

    const selectedOption = shipping?.options.find((o) => o.code === shipping.selectedCode) ?? null;
    const shippingCostMinor = selectedOption?.costMinor ?? 0;

    const quote =
      shippingCostMinor > 0
        ? computeQuote({ ...priceable, shipping: { costMinor: shippingCostMinor } })
        : goodsOnly;

    this.logger.log(
      `Quoted ${lines.length} line(s) for ${destination.country}` +
        `${destination.region ? `-${destination.region}` : ''}: ` +
        `subtotal ${quote.subtotalMinor}, discount ${quote.discountMinor}, ` +
        `shipping ${quote.shippingMinor}` +
        `${shipping?.selectedCode ? ` (${shipping.selectedCode}, ${shipping.weightGrams}g)` : ''}, ` +
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
      shipping,
    };
  }

  /**
   * What delivery costs for this basket, or null if nothing was asked.
   *
   * Weight is summed here rather than in shipping-service because this is where
   * the products already are: `pricedProducts` fetched every one of them a
   * moment ago. Sending shipping a weight rather than a basket also keeps it
   * ignorant of catalog, which is why it needs no HTTP client of its own.
   *
   * A requested service level that is not on offer — express dropped out
   * because the basket got heavier, and the storefront still held the code —
   * falls back to the cheapest and says so, rather than failing the quote. A
   * cart page that goes blank because a stale radio button is worse than one
   * that quietly quotes standard and tells you why.
   */
  private async shippingFor(
    input: CreateQuoteDto,
    destination: Destination,
    lines: QuoteLineInput[],
    products: Awaited<ReturnType<CatalogClient['pricedProducts']>>,
    discountedSubtotalMinor: number,
    correlationId?: string,
  ): Promise<QuoteShipping | null> {
    const weightGrams = lines.reduce(
      (total, line) => total + (products.get(line.productId)?.weightGrams ?? 0) * line.qty,
      0,
    );

    const rates = await this.shipping.rates(
      {
        country: destination.country,
        region: destination.region,
        weightGrams,
        subtotalMinor: discountedSubtotalMinor,
      },
      correlationId,
    );

    const requested = input.shippingRateCode?.trim().toLowerCase();
    const match = requested ? rates.options.find((o) => o.code === requested) : undefined;

    return {
      zone: rates.zone,
      weightGrams: rates.weightGrams,
      options: rates.options,
      selectedCode: match?.code ?? rates.cheapestCode,
      requestedCodeUnavailable: requested !== undefined && match === undefined,
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
    shippingTaxable: row.shippingTaxable,
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
