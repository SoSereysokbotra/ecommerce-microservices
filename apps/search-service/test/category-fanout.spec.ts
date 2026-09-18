import { Client } from '@opensearch-project/opensearch';
import { DomainEvent } from '@libs/rabbitmq';
import { CatalogEventsListener } from '../src/events/catalog-events.listener';
import {
  CategoryEventPayload,
  buildCategoryFanout,
  isCategoryEventPayload,
} from '../src/modules/search/category-fanout';
import { OpenSearchClient } from '../src/modules/search/opensearch.client';
import { PRODUCTS_INDEX } from '../src/modules/search/products.index';
import { ProductsProjection } from '../src/modules/search/products.projection';

/**
 * The fan-out, without a cluster. What matters is that the version guard is
 * *in the query* — a stale rename must match nothing — and that the script
 * touches only the category's fields, never the product's own version.
 */
const category: CategoryEventPayload = {
  id: 'c-1',
  slug: 'apparel',
  name: 'Clothing',
  description: null,
  version: 3,
  updatedAt: '2026-09-18T10:00:00.000Z',
};

describe('buildCategoryFanout', () => {
  it('targets the category and only documents carrying an older categoryVersion', () => {
    const params = buildCategoryFanout(category);
    const body = params.body as { query: { bool: { filter: unknown[] } } };
    expect(params.index).toBe(PRODUCTS_INDEX);
    expect(body.query.bool.filter).toEqual([
      { term: { categoryId: 'c-1' } },
      { range: { categoryVersion: { lt: 3 } } },
    ]);
  });

  it('rewrites slug, name and categoryVersion and nothing else', () => {
    const body = buildCategoryFanout(category).body as {
      script: { source: string; params: Record<string, unknown> };
    };
    expect(body.script.params).toEqual({ slug: 'apparel', name: 'Clothing', version: 3 });
    expect(body.script.source).toContain('ctx._source.categorySlug');
    expect(body.script.source).toContain('ctx._source.categoryName');
    expect(body.script.source).toContain('ctx._source.categoryVersion');
    // The product's own version is the product's. Never touched here.
    expect(body.script.source).not.toMatch(/_source\.version\b/);
  });

  it('proceeds past a concurrent product write rather than aborting the batch', () => {
    const params = buildCategoryFanout(category);
    expect(params.conflicts).toBe('proceed');
    expect(params.refresh).toBe(true);
  });
});

describe('isCategoryEventPayload', () => {
  it('accepts the shape catalog emits', () => {
    expect(isCategoryEventPayload(category)).toBe(true);
  });

  it.each([
    ['no id', { ...category, id: undefined }],
    ['no slug', { ...category, slug: undefined }],
    ['no version', { ...category, version: undefined }],
    ['not an object', 42],
  ])('rejects %s', (_label, value) => {
    expect(isCategoryEventPayload(value)).toBe(false);
  });
});

describe('ProductsProjection.fanoutCategory via the listener', () => {
  function listenerWith(updateByQuery: jest.Mock): CatalogEventsListener {
    const client = { updateByQuery } as unknown as Client;
    const projection = new ProductsProjection(new OpenSearchClient(client));
    return new CatalogEventsListener({} as never, projection);
  }

  function event(eventType: string, payload: unknown): DomainEvent {
    return {
      eventId: 'e-1',
      eventType,
      occurredAt: '2026-09-18T10:00:00.000Z',
      aggregateId: 'c-1',
      correlationId: 'corr',
      version: 1,
      payload,
    };
  }

  it('runs one update-by-query for category.updated and reports the counts', async () => {
    const updateByQuery = jest.fn(async () => ({ body: { total: 6, updated: 6 } }));
    await listenerWith(updateByQuery).handle(event('category.updated', category));
    expect(updateByQuery).toHaveBeenCalledTimes(1);
    expect(updateByQuery).toHaveBeenCalledWith(buildCategoryFanout(category));
  });

  it('treats zero matches (a stale rename) as a no-op, not an error', async () => {
    const updateByQuery = jest.fn(async () => ({ body: { total: 0, updated: 0 } }));
    await expect(
      listenerWith(updateByQuery).handle(event('category.updated', { ...category, version: 1 })),
    ).resolves.toBeUndefined();
  });

  it('drops an unusable category payload instead of throwing', async () => {
    const updateByQuery = jest.fn();
    await expect(
      listenerWith(updateByQuery).handle(event('category.updated', { id: 'c-1' })),
    ).resolves.toBeUndefined();
    expect(updateByQuery).not.toHaveBeenCalled();
  });
});
