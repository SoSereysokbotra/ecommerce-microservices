import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { announceCategory, announceProduct } from '../../events/product-events';
import { ProductEntity } from '../products/product.entity';
import { CategoryEntity } from '../categories/category.entity';

export interface RepublishResult {
  products: number;
  categories: number;
}

/**
 * The write side owns replay.
 *
 * A read model must be rebuildable from events alone — that is the property
 * that makes it a projection rather than a second database. But the read
 * side cannot walk catalog's tables to rebuild itself; that is the rule.
 * And catalog's outbox is a delivery queue, not a retained log, so there is
 * nothing to replay *from*. So the write side re-announces: every product
 * and every category, **at its current version**, as one more
 * `product.updated` / `category.updated`.
 *
 * Because every consumer write is versioned, this is safe to run against a
 * live index at any time: a republished v7 cannot overwrite a v8 that landed
 * in the meantime, and a v7 that is already there is a 409 the projection
 * treats as done. A full reindex is therefore just
 * `POST /search/admin/recreate-index` followed by this.
 *
 * Categories go first so that, on a cold index, the category fan-out (step 6)
 * has nothing to fan out to yet and the products that follow carry the
 * current category name themselves.
 *
 * This is also the **first caller of `announceCategory`** — there is no
 * category write API — and therefore the first `category.updated` on the bus.
 */
@Injectable()
export class RepublishService {
  private readonly logger = new Logger(RepublishService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  async republishAll(correlationId?: string): Promise<RepublishResult> {
    // One transaction: the outbox rows are appended together, and the relay
    // drains them in order of insertion. Three categories and a dozen
    // products; if the catalogue ever grew to where this transaction was a
    // problem, batching by id range would be the change, not a cursor on
    // the read side.
    return this.dataSource.transaction(async (manager) => {
      const categories = await manager.find(CategoryEntity, { order: { slug: 'ASC' } });
      for (const category of categories) {
        await announceCategory(this.outbox, manager, 'updated', category, correlationId);
      }

      const byId = new Map(categories.map((category) => [category.id, category]));
      const products = await manager.find(ProductEntity, { order: { sku: 'ASC' } });
      for (const product of products) {
        const category = product.categoryId ? (byId.get(product.categoryId) ?? null) : null;
        await announceProduct(this.outbox, manager, 'updated', product, category, correlationId);
      }

      this.logger.log(
        `Republished ${products.length} products and ${categories.length} categories`,
      );
      return { products: products.length, categories: categories.length };
    });
  }
}
