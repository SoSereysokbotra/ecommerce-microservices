import { EntityManager } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { ProductEntity } from '../modules/products/product.entity';
import { CategoryEntity } from '../modules/categories/category.entity';

/**
 * What catalog tells the world when a product or category changes.
 *
 * ## Full state, not a diff
 *
 * A consumer building a projection must be able to write the whole document
 * from one event. A `product.updated` that carried only the changed fields
 * would force the read side to already have the rest — which it will not, if
 * it is being rebuilt from scratch by replaying. So every event is the entire
 * row, and `product.created` and `product.updated` differ only in name; the
 * search projection treats both as an upsert.
 *
 * ## The version is the point
 *
 * It travels on every event so the read side can refuse a stale one. The bus
 * delivers at least once and in no guaranteed order; v6 will one day arrive
 * after v7, and a marker that says "seen this event id" cannot catch that. A
 * version can. See docs/M12_SEARCH_PLAN.md §4.
 *
 * ## No product.deleted
 *
 * Catalog never deletes — it sets `active: false`, and the event carries the
 * flag. A tombstone event would be a second way to say the same thing.
 */
export function productPayload(product: ProductEntity, category: CategoryEntity | null) {
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    description: product.description ?? null,
    priceMinor: product.priceMinor,
    currency: product.currency,
    weightGrams: product.weightGrams,
    active: product.active,
    categoryId: product.categoryId ?? null,
    // Denormalised for the projection, which needs a slug to facet on and a
    // name to display without a join. A category rename fans out separately.
    categorySlug: category?.slug ?? null,
    categoryName: category?.name ?? null,
    categoryVersion: category?.version ?? null,
    version: product.version,
    updatedAt: product.updatedAt,
  };
}

export function categoryPayload(category: CategoryEntity) {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    description: category.description ?? null,
    version: category.version,
    updatedAt: category.updatedAt,
  };
}

/**
 * Append a product event inside the caller's transaction.
 *
 * The row and the event commit together or not at all — the outbox pattern,
 * unchanged since M3. There is no window in which a product exists with no
 * event, or an event exists for a product that rolled back.
 */
export async function announceProduct(
  outbox: OutboxService,
  manager: EntityManager,
  kind: 'created' | 'updated',
  product: ProductEntity,
  category: CategoryEntity | null,
  correlationId?: string,
): Promise<void> {
  await outbox.append(manager, {
    eventType: `product.${kind}`,
    aggregateId: product.id,
    correlationId,
    payload: productPayload(product, category),
  });
}

export async function announceCategory(
  outbox: OutboxService,
  manager: EntityManager,
  kind: 'created' | 'updated',
  category: CategoryEntity,
  correlationId?: string,
): Promise<void> {
  await outbox.append(manager, {
    eventType: `category.${kind}`,
    aggregateId: category.id,
    correlationId,
    payload: categoryPayload(category),
  });
}
