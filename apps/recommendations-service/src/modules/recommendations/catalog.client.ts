import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER, getTraceparent } from '@libs/common';

export interface CatalogProduct {
  id: string;
  sku: string;
  slug: string;
  name: string;
  priceMinor: number;
  currency: string;
  weightGrams?: number;
  categoryId?: string | null;
  active: boolean;
}

interface PaginatedProductsResponse {
  data: CatalogProduct[];
  nextCursor?: string | null;
}

/**
 * Reads product snapshots from catalog-service to enrich recommendation hits.
 *
 * M14 plan §13 step 3 & §14 settled: recommendations-service enriches hits itself
 * by reading catalog. Returning bare IDs would force the storefront to issue four
 * additional HTTP requests and orchestrate enrichment client-side.
 *
 * ## Error mapping (HANDOFF.md §7)
 *
 * An unreachable catalog or network timeout produces a 503 Service Unavailable,
 * never a 400 Bad Request. The client's request was valid; telling them it was bad
 * masks downstream infrastructure outages and prevents legitimate retry attempts.
 */
@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);
  private readonly baseUrl = (
    process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002'
  ).replace(/\/$/, '');
  private readonly timeoutMs = Number(process.env.CATALOG_TIMEOUT_MS ?? 3000);

  /**
   * Fetches product snapshots for a list of IDs in a single bulk request.
   *
   * @param productIds List of product UUIDs
   * @param correlationId Distributed tracing ID
   */
  async getProductsByIds(
    productIds: readonly string[],
    correlationId?: string,
  ): Promise<CatalogProduct[]> {
    const unique = [...new Set(productIds)].filter(Boolean);
    if (unique.length === 0) {
      return [];
    }

    const idsParam = unique.map((id) => encodeURIComponent(id)).join(',');
    const url = `${this.baseUrl}/api/v1/catalog/products?ids=${idsParam}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          ...(correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {}),
          ...(getTraceparent() ? { [TRACEPARENT_HEADER]: getTraceparent() } : {}),
        },
      });

      if (response.status >= 500) {
        throw new ServiceUnavailableException(
          `catalog-service returned ${response.status}; recommendations could not be enriched`,
        );
      }

      if (!response.ok) {
        throw new BadRequestException(`catalog-service returned ${response.status}`);
      }

      const body = (await response.json()) as PaginatedProductsResponse;
      return body.data ?? [];
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof BadRequestException) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`catalog lookup failed: ${reason} [${correlationId ?? '-'}]`);
      throw new ServiceUnavailableException(`catalog-service unreachable: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
