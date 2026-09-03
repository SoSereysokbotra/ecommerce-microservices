import { Injectable, Logger } from '@nestjs/common';
import { StockLevels } from './cart-merge';

interface StockRow {
  productId: string;
  availableQty: number;
}

/**
 * Reads available stock so a merged cart can be capped at what actually exists.
 *
 * This is the only cross-service call in M7, and it is deliberately a **read
 * before anything commits** — the same justification handoff §7 gives for the
 * catalog price lookup in orders. Nothing here changes state, so a failure can
 * be absorbed rather than propagated.
 */
@Injectable()
export class InventoryClient {
  private readonly logger = new Logger(InventoryClient.name);
  private readonly baseUrl = process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003';
  private readonly timeoutMs = Number(process.env.INVENTORY_TIMEOUT_MS ?? 3000);

  /**
   * @returns stock per product, or `null` when inventory could not be reached.
   *
   * `null` is meaningful: `mergeCarts` treats it as "do not cap". Failing a
   * login because a stock lookup timed out would be a worse outcome than a
   * briefly optimistic cart, and the order path re-checks stock anyway.
   */
  async stockFor(
    productIds: readonly string[],
    correlationId?: string,
  ): Promise<StockLevels | null> {
    if (productIds.length === 0) {
      return new Map();
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/inventory/stock?productIds=${productIds.join(',')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: correlationId ? { 'x-correlation-id': correlationId } : {},
      });

      if (!response.ok) {
        this.logger.warn(`inventory returned ${response.status}; merging without a stock cap`);
        return null;
      }

      const body = (await response.json()) as StockRow[] | { data: StockRow[] };
      const rows = Array.isArray(body) ? body : (body.data ?? []);

      return new Map(
        rows
          .filter((row) => typeof row?.productId === 'string' && Number.isFinite(row.availableQty))
          .map((row) => [row.productId, row.availableQty]),
      );
    } catch (error) {
      this.logger.warn(
        `inventory unreachable (${(error as Error).message}); merging without a stock cap`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
