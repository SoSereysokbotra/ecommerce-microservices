import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CORRELATION_ID_HEADER } from '@libs/common';

interface CatalogProductResponse {
  id: string;
  sku: string;
  name: string;
  priceMinor: number;
  currency: string;
  categoryId: string | null;
  active: boolean;
}

interface CatalogCategoryResponse {
  id: string;
  slug: string;
}

/** A product as the calculator needs it: priced, and carrying a category slug. */
export interface PricedProduct {
  id: string;
  sku: string;
  name: string;
  priceMinor: number;
  currency: string;
  /** Category **slug**, not id — see the note on `categorySlugs` below. */
  category: string | null;
}

/**
 * Reads prices and categories from catalog-service.
 *
 * This is the only cross-service call pricing makes, and it is a **read before
 * anything commits**: a quote writes nothing, so a failure here rejects the
 * request cleanly with nothing left half-done. That is the same justification
 * handoff §7 gives for the catalog lookup that used to live in orders — and
 * from M8 this *is* that lookup, moved, so that one implementation of "what
 * does this basket cost" exists rather than two.
 *
 * Note the contrast with cart-service's InventoryClient, which returns null on
 * failure so a merge can proceed uncapped. Nothing here is optional: a basket
 * whose prices could not be read has no total, and pretending otherwise would
 * quote a number that is not the price.
 */
@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);
  private readonly baseUrl = (
    process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002'
  ).replace(/\/$/, '');
  private readonly timeoutMs = Number(process.env.CATALOG_TIMEOUT_MS ?? 3000);

  /**
   * Fetch every product in a basket, with its category resolved to a slug.
   *
   * Products and the category list are fetched concurrently — the catalog has
   * no bulk-by-ids endpoint, so a basket of five products is five lookups, and
   * doing them in sequence would make a quote as slow as its longest chain.
   */
  async pricedProducts(
    productIds: readonly string[],
    correlationId?: string,
  ): Promise<Map<string, PricedProduct>> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) {
      return new Map();
    }

    const [products, categorySlugs] = await Promise.all([
      Promise.all(unique.map((id) => this.product(id, correlationId))),
      this.categorySlugs(correlationId),
    ]);

    const priced = new Map<string, PricedProduct>();

    for (const product of products) {
      if (!product.active) {
        // The same rejection orders-service has always made. Keeping it here
        // means that when orders delegates its pricing to this service, an
        // inactive product is still refused rather than quietly quoted.
        throw new BadRequestException(`Product '${product.sku}' is not available`);
      }

      priced.set(product.id, {
        id: product.id,
        sku: product.sku,
        name: product.name,
        priceMinor: product.priceMinor,
        currency: product.currency,
        category: product.categoryId ? (categorySlugs.get(product.categoryId) ?? null) : null,
      });
    }

    const currencies = new Set([...priced.values()].map((p) => p.currency));
    if (currencies.size > 1) {
      throw new BadRequestException(
        `A basket cannot mix currencies (got ${[...currencies].sort().join(', ')})`,
      );
    }

    return priced;
  }

  private async product(id: string, correlationId?: string): Promise<CatalogProductResponse> {
    return this.get<CatalogProductResponse>(
      `${this.baseUrl}/api/v1/catalog/products/${encodeURIComponent(id)}`,
      correlationId,
      `Product '${id}' not found`,
    );
  }

  /**
   * Category id to slug.
   *
   * Tax rules are keyed by category **slug** rather than id, because a table of
   * uuids is unreadable to whoever maintains the rates and would silently stop
   * matching if the catalog were ever reseeded with fresh ids. The cost is this
   * extra lookup, and it is deliberately not cached: a stale category map is a
   * wrong tax rate, which is exactly the trade docs/M8_PRICING_PLAN.md §2 makes
   * for the rates themselves.
   */
  private async categorySlugs(correlationId?: string): Promise<Map<string, string>> {
    const categories = await this.get<CatalogCategoryResponse[]>(
      `${this.baseUrl}/api/v1/catalog/categories`,
      correlationId,
      'Categories not found',
    );

    return new Map(categories.map((c) => [c.id, c.slug]));
  }

  private async get<T>(
    url: string,
    correlationId: string | undefined,
    notFound: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {},
      });

      if (response.status === 404) {
        throw new NotFoundException(notFound);
      }
      if (!response.ok) {
        throw new BadRequestException(`catalog-service returned ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`catalog lookup failed: ${reason} [${correlationId ?? '-'}]`);
      throw new BadRequestException(`catalog-service unreachable: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
