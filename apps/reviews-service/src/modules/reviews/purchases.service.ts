import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PurchaseEntity } from './purchase.entity';

export interface PurchasedLine {
  productId: string;
  sku: string;
  qty: number;
}

/**
 * Turns a confirmed order into the right to review what was in it.
 *
 * Nothing else writes `purchases` — there is no API that grants eligibility,
 * which is the whole idea: the permission is a fact that arrived on the bus,
 * not a role someone can be given.
 */
@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  /**
   * Records one row per line, inside the caller's transaction.
   *
   * `ON CONFLICT DO NOTHING` rather than a catch: a unique violation aborts the
   * whole Postgres transaction, so anything written afterwards fails with
   * "current transaction is aborted" — the M9 lesson (HANDOFF §5). Branching on
   * zero rows is the shape that survives a republished event with a new id,
   * which the `processed_events` marker cannot catch.
   *
   * Returns how many rows were new, so the caller can log a republish as the
   * no-op it is rather than as work done.
   */
  async recordPurchase(
    manager: EntityManager,
    input: { customerId: string; orderId: string; items: PurchasedLine[] },
  ): Promise<number> {
    let inserted = 0;

    for (const item of input.items) {
      const rows = (await manager.query(
        `INSERT INTO purchases (customer_id, product_id, order_id, sku, qty)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT "UQ_purchases_customer_product_order" DO NOTHING
         RETURNING id`,
        [input.customerId, item.productId, input.orderId, item.sku, item.qty],
      )) as { id: string }[];

      if (rows.length > 0) {
        inserted += 1;
      }
    }

    return inserted;
  }

  /** Has this customer bought this product? The eligibility rule, as a read. */
  async hasPurchased(
    manager: EntityManager,
    customerId: string,
    productId: string,
  ): Promise<PurchaseEntity | null> {
    return manager.findOne(PurchaseEntity, {
      where: { customerId, productId },
      order: { createdAt: 'DESC' },
    });
  }
}
