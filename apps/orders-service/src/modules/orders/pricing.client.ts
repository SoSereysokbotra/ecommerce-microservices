import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CORRELATION_ID_HEADER } from '@libs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

/** One priced line, as pricing-service returns it. */
export interface QuotedLine {
  productId: string;
  sku: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  lineDiscountMinor: number;
  taxableMinor: number;
  taxRateBp: number;
  taxMinor: number;
}

export interface Quote {
  currency: string;
  destination: { country: string; region: string | null };
  lines: QuotedLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  netMinor: number;
  totalMinor: number;
  coupon?: QuoteCoupon | null;
}

export interface QuoteRequest {
  items: { productId: string; qty: number }[];
  destination?: { country: string; region?: string };
  couponCode?: string;
  customerId?: string;
}

/** What a coupon code did to the basket, as pricing reports it. */
export interface QuoteCoupon {
  code: string;
  applied: boolean;
  amountMinor: number;
  rejectedBecause: string | null;
}

export type HoldResult =
  { ok: true; couponId: string; amountMinor: number } | { ok: false; reason: string };

/**
 * Asks pricing-service what a basket costs.
 *
 * This replaces the catalog loop that used to live in `OrdersService`. Orders
 * no longer talks to catalog at all — there is now exactly one implementation
 * of "what does this basket cost", and both the storefront's cart page and this
 * service get their answer from it. Two implementations could disagree, and the
 * way you find that out is a customer seeing one number and being charged
 * another.
 *
 * It remains a **read before anything commits**, which is the property that
 * made the old catalog call acceptable (handoff §7): nothing has been written
 * when this runs, so a failure rejects the request cleanly with nothing left
 * half-done. The cost is one more hop in the critical path — an order now needs
 * pricing *and* catalog to be up, where before it needed only catalog. That is
 * one more thing that can be down, not a new kind of failure.
 *
 * Uses `HttpService` rather than the native `fetch` that cart-service and
 * pricing-service use, because it is already wired into this module with the
 * correlation-id pattern established. Swapping it would be churn unrelated to
 * M8.
 */
@Injectable()
export class PricingClient {
  private readonly logger = new Logger(PricingClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async quote(request: QuoteRequest, correlationId?: string): Promise<Quote> {
    const base = this.config.get<string>('pricingServiceUrl');

    try {
      const response = await firstValueFrom(
        this.http.post<Quote>(`${base}/api/v1/pricing/quote`, request, {
          headers: correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {},
          timeout: 5000,
        }),
      );
      return response.data;
    } catch (error) {
      const status = (error as AxiosError).response?.status;

      // Pricing already produces the right message for a missing or unavailable
      // product, so pass its rejection through rather than replacing it with a
      // vaguer one of our own.
      if (status === 404) {
        throw new NotFoundException(describe(error));
      }
      if (status === 400) {
        throw new BadRequestException(describe(error));
      }

      // Anything else — pricing is down, timed out, or reported an upstream of
      // its own as unavailable — is not the customer's doing. Say 503 so the
      // storefront can offer a retry instead of showing "bad request" for an
      // order that was perfectly valid.
      this.logger.warn(`pricing lookup failed: ${describe(error)} [${correlationId ?? '-'}]`);
      throw new ServiceUnavailableException(
        `Could not price this order right now: ${describe(error)}`,
      );
    }
  }

  /**
   * Claim one use of a coupon for this order.
   *
   * Called with an order id generated *before* the order row exists, so the
   * hold and the order agree on it. Pricing refuses a second hold for the same
   * order id, which makes a retry safe.
   */
  async holdCoupon(
    input: { code: string; orderId: string; customerId: string; amountMinor: number },
    correlationId?: string,
  ): Promise<HoldResult> {
    const base = this.config.get<string>('pricingServiceUrl');

    try {
      const response = await firstValueFrom(
        this.http.post<HoldResult>(`${base}/api/v1/pricing/coupons/hold`, input, {
          headers: correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {},
          timeout: 5000,
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`coupon hold failed: ${describe(error)} [${correlationId ?? '-'}]`);
      throw new ServiceUnavailableException(
        `Could not apply that coupon right now: ${describe(error)}`,
      );
    }
  }

  /**
   * Give a claimed use back when the order it was claimed for never existed.
   *
   * The normal path is `order.cancelled`, consumed by pricing — but that needs
   * an order, and this covers the window where the hold succeeded and the
   * insert did not.
   */
  async releaseCoupon(orderId: string, correlationId?: string): Promise<void> {
    const base = this.config.get<string>('pricingServiceUrl');

    await firstValueFrom(
      this.http.post(
        `${base}/api/v1/pricing/coupons/release`,
        { orderId },
        {
          headers: correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {},
          timeout: 5000,
        },
      ),
    );
  }
}

function describe(error: unknown): string {
  const axiosError = error as AxiosError<{ message?: string | string[] }>;
  const body = axiosError.response?.data?.message;

  if (body) {
    return Array.isArray(body) ? body.join(', ') : body;
  }
  if (axiosError.code) {
    return `${axiosError.code}: ${axiosError.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
