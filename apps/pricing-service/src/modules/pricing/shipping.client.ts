import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CORRELATION_ID_HEADER } from '@libs/common';

export interface ShippingOption {
  code: string;
  name: string;
  costMinor: number;
  freeApplied: boolean;
  listPriceMinor: number;
  currency: string;
}

export interface ShippingRates {
  /** Null when no zone covers the destination — the shop does not ship there. */
  zone: string | null;
  weightGrams: number;
  /** Cheapest first. Empty when nothing ships to this destination. */
  options: ShippingOption[];
  cheapestCode: string | null;
}

/**
 * Asks shipping-service what delivery costs.
 *
 * ## Why pricing makes this call, and not orders
 *
 * Shipping cost changes the order total, and M8 spent a milestone establishing
 * that **exactly one thing** computes a total. If orders added a rate to a
 * quote, orders could produce a number the cart page could not, and the
 * storefront would have to reproduce the same addition to display it — two
 * implementations again, differing only in that the new one looks trivial.
 *
 * pricing is also the service already holding what a rate needs. It has just
 * fetched every product in the basket, so it knows the weight; it has just
 * applied the promotions, so it knows the discounted subtotal that a
 * free-shipping threshold is measured against. Orders knows neither without
 * asking somebody. See docs/M10_SHIPPING_PLAN.md §4.
 *
 * ## The failure mode this gets right
 *
 * A 400 means "you sent something wrong"; anything else means "we could not
 * reach a dependency". `CatalogClient` used to map every non-404 failure to
 * `BadRequestException`, so a catalog timeout told a customer their perfectly
 * valid basket was malformed *and* told them not to retry (HANDOFF §7). Same
 * mistake was available here and is not made.
 *
 * Native `fetch` rather than `HttpService`, matching `CatalogClient` next door.
 */
@Injectable()
export class ShippingClient {
  private readonly logger = new Logger(ShippingClient.name);
  private readonly baseUrl = (
    process.env.SHIPPING_SERVICE_URL ?? 'http://shipping-service:3008'
  ).replace(/\/$/, '');
  private readonly timeoutMs = Number(process.env.SHIPPING_TIMEOUT_MS ?? 3000);

  async rates(
    input: { country: string; region: string | null; weightGrams: number; subtotalMinor: number },
    correlationId?: string,
  ): Promise<ShippingRates> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/shipping/rates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {}),
        },
        body: JSON.stringify({
          destination: {
            country: input.country,
            ...(input.region ? { region: input.region } : {}),
          },
          weightGrams: input.weightGrams,
          subtotalMinor: input.subtotalMinor,
        }),
        signal: controller.signal,
      });

      if (response.status === 400) {
        // Shipping rejected the request itself. Passing its message through
        // rather than replacing it keeps the reason readable.
        throw new BadRequestException(
          `Could not rate this basket: ${await describeBody(response)}`,
        );
      }

      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Shipping is unavailable (HTTP ${response.status}): ${await describeBody(response)}`,
        );
      }

      return (await response.json()) as ShippingRates;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      // A timeout, a DNS failure, a connection refused. Not the customer's
      // doing, and retryable — so 503, and never 400.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`shipping lookup failed: ${reason} [${correlationId ?? '-'}]`);
      throw new ServiceUnavailableException(`Could not reach shipping: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function describeBody(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    const message = body?.message;
    if (message) {
      return Array.isArray(message) ? message.join(', ') : message;
    }
  } catch {
    // Not JSON, or an empty body. The status alone is what we have.
  }
  return response.statusText || 'no detail';
}
