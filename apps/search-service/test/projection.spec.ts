import { Client, errors } from '@opensearch-project/opensearch';
import { DomainEvent } from '@libs/rabbitmq';
import { CatalogEventsListener } from '../src/events/catalog-events.listener';
import { OpenSearchClient } from '../src/modules/search/opensearch.client';
import {
  BASE_CURRENCY_EXPONENT,
  ProductEventPayload,
  isProductEventPayload,
  toProductDocument,
} from '../src/modules/search/product-document';
import { PRODUCTS_INDEX, PRODUCTS_INDEX_BODY } from '../src/modules/search/products.index';
import {
  PRODUCT_UPSERT_SCRIPT,
  ProductsProjection,
  RATING_UPSERT_SCRIPT,
  RatingEventPayload,
  isRatingEventPayload,
} from '../src/modules/search/products.projection';

/**
 * The projection, without a cluster or a broker.
 *
 * M13 Step 4 replaces index() with scripted update() so catalog product updates
 * do not overwrite ratings projected by reviews-service (docs/M13_REVIEWS_PLAN.md §5 Option A).
 *
 * Key guarantees tested:
 * - Product script does not touch rating fields.
 * - Rating script does not touch product fields.
 * - Each script sets ctx.op = 'none' and returns noop on a stale version.
 * - Mocks return realistic OpenSearch responses ({ body: { result: 'noop' | 'updated' | 'created' } }).
 * - Strict mapping invariants hold.
 */
const payload: ProductEventPayload = {
  id: 'p-1',
  sku: 'TEE-001',
  slug: 'classic-tee',
  name: 'Classic Tee',
  description: 'A tee.',
  priceMinor: 1999,
  currency: 'USD',
  weightGrams: 180,
  active: true,
  categoryId: 'c-1',
  categorySlug: 'apparel',
  categoryName: 'Apparel',
  categoryVersion: 1,
  version: 7,
  updatedAt: '2026-09-17T10:00:00.000Z',
};

const ratingPayload: RatingEventPayload = {
  productId: 'p-1',
  ratingSum: 9,
  ratingCount: 2,
  ratingAvgE2: 450,
  version: 3,
};

describe('toProductDocument', () => {
  it('maps a full event to a document with the base-currency exponent', () => {
    const doc = toProductDocument(payload);
    expect(doc).toEqual({ ...payload, exponent: BASE_CURRENCY_EXPONENT });
  });

  it('keeps an inactive product — the flag is a field, not a tombstone', () => {
    expect(toProductDocument({ ...payload, active: false }).active).toBe(false);
  });

  it('indexes a product with no category, with nulls rather than empty strings', () => {
    const doc = toProductDocument({
      ...payload,
      categoryId: null,
      categorySlug: null,
      categoryName: null,
      categoryVersion: null,
    });
    expect(doc.categoryId).toBeNull();
    expect(doc.categorySlug).toBeNull();
    expect(doc.categoryName).toBeNull();
    expect(doc.categoryVersion).toBeNull();
  });

  it('serialises a Date updatedAt to ISO', () => {
    const doc = toProductDocument({ ...payload, updatedAt: new Date('2026-09-17T10:00:00Z') });
    expect(doc.updatedAt).toBe('2026-09-17T10:00:00.000Z');
  });

  it('produces only fields the strict mapping knows', () => {
    const mapped = Object.keys(PRODUCTS_INDEX_BODY.mappings.properties);
    const docKeys = Object.keys(toProductDocument(payload));
    for (const key of docKeys) {
      expect(mapped).toContain(key);
    }
  });
});

describe('isProductEventPayload', () => {
  it('accepts the shape catalog emits', () => {
    expect(isProductEventPayload(payload)).toBe(true);
  });

  it.each([
    ['no id', { ...payload, id: undefined }],
    ['no version', { ...payload, version: undefined }],
    ['version 0', { ...payload, version: 0 }],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, value) => {
    expect(isProductEventPayload(value)).toBe(false);
  });
});

describe('isRatingEventPayload', () => {
  it('accepts the shape reviews-service emits', () => {
    expect(isRatingEventPayload(ratingPayload)).toBe(true);
  });

  it.each([
    ['no productId', { ...ratingPayload, productId: undefined }],
    ['empty productId', { ...ratingPayload, productId: '' }],
    ['no version', { ...ratingPayload, version: undefined }],
    ['version 0', { ...ratingPayload, version: 0 }],
    ['no ratingAvgE2', { ...ratingPayload, ratingAvgE2: undefined }],
    ['no ratingCount', { ...ratingPayload, ratingCount: undefined }],
    ['negative ratingCount', { ...ratingPayload, ratingCount: -1 }],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, value) => {
    expect(isRatingEventPayload(value)).toBe(false);
  });
});

describe('Projection scripts', () => {
  it('the product script must not mention rating fields', () => {
    expect(PRODUCT_UPSERT_SCRIPT).not.toMatch(/rating/i);
  });

  it('the rating script must not mention product fields', () => {
    expect(RATING_UPSERT_SCRIPT).not.toMatch(
      /\b(id|sku|slug|name|description|priceMinor|currency|exponent|categoryId|categorySlug|categoryName|categoryVersion|active|weightGrams|updatedAt)\b/,
    );
  });

  it('product script guards with version and handles null version on empty upsert', () => {
    expect(PRODUCT_UPSERT_SCRIPT).toContain(
      'if (ctx._source.version != null && ctx._source.version >= params.version)',
    );
    expect(PRODUCT_UPSERT_SCRIPT).toContain("ctx.op = 'none'");
  });

  it('rating script guards with ratingVersion and handles null ratingVersion on empty upsert', () => {
    expect(RATING_UPSERT_SCRIPT).toContain(
      'if (ctx._source.ratingVersion != null && ctx._source.ratingVersion >= params.version)',
    );
    expect(RATING_UPSERT_SCRIPT).toContain("ctx.op = 'none'");
  });
});

function projectionWith(updateImpl: jest.Mock): {
  projection: ProductsProjection;
  update: jest.Mock;
} {
  const client = { update: updateImpl } as unknown as Client;
  return { projection: new ProductsProjection(new OpenSearchClient(client)), update: updateImpl };
}

function conflict(): errors.ResponseError {
  return new errors.ResponseError({
    body: { error: { type: 'version_conflict_engine_exception' } },
    statusCode: 409,
    headers: {},
    warnings: null,
    meta: {} as never,
  });
}

describe('ProductsProjection.upsert', () => {
  it('writes with scripted update, scripted_upsert: true, and retry_on_conflict: 3', async () => {
    const { projection, update } = projectionWith(
      jest.fn(async () => ({ body: { result: 'created' } })),
    );
    const doc = toProductDocument(payload);

    await expect(projection.upsert(doc)).resolves.toBe('written');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        index: PRODUCTS_INDEX,
        id: 'p-1',
        retry_on_conflict: 3,
        refresh: true,
        body: expect.objectContaining({
          scripted_upsert: true,
          script: {
            lang: 'painless',
            source: PRODUCT_UPSERT_SCRIPT,
            params: doc,
          },
          upsert: {},
        }),
      }),
    );
  });

  it('returns noop when OpenSearch result is noop (stale or equal version)', async () => {
    const { projection } = projectionWith(jest.fn(async () => ({ body: { result: 'noop' } })));

    await expect(projection.upsert(toProductDocument(payload))).resolves.toBe('noop');
  });

  it('treats a version conflict exception as noop, not as a failure to retry', async () => {
    const { projection } = projectionWith(
      jest.fn(async () => {
        throw conflict();
      }),
    );

    await expect(projection.upsert(toProductDocument(payload))).resolves.toBe('noop');
  });

  it('rethrows anything that is not a version conflict', async () => {
    const { projection } = projectionWith(
      jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(projection.upsert(toProductDocument(payload))).rejects.toThrow('ECONNREFUSED');
  });
});

describe('ProductsProjection.applyRating', () => {
  it('writes rating fields with scripted update and retry_on_conflict: 3', async () => {
    const { projection, update } = projectionWith(
      jest.fn(async () => ({ body: { result: 'updated' } })),
    );

    await expect(projection.applyRating(ratingPayload)).resolves.toBe('written');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        index: PRODUCTS_INDEX,
        id: 'p-1',
        retry_on_conflict: 3,
        refresh: true,
        body: expect.objectContaining({
          scripted_upsert: true,
          script: {
            lang: 'painless',
            source: RATING_UPSERT_SCRIPT,
            params: {
              ratingAvgE2: 450,
              ratingCount: 2,
              version: 3,
            },
          },
          upsert: {},
        }),
      }),
    );
  });

  it('returns noop when rating update result is noop (stale rating version)', async () => {
    const { projection } = projectionWith(jest.fn(async () => ({ body: { result: 'noop' } })));

    await expect(projection.applyRating(ratingPayload)).resolves.toBe('noop');
  });

  it('treats a version conflict exception on rating update as noop', async () => {
    const { projection } = projectionWith(
      jest.fn(async () => {
        throw conflict();
      }),
    );

    await expect(projection.applyRating(ratingPayload)).resolves.toBe('noop');
  });

  it('rethrows unexpected error on rating update', async () => {
    const { projection } = projectionWith(
      jest.fn(async () => {
        throw new Error('ETIMEDOUT');
      }),
    );

    await expect(projection.applyRating(ratingPayload)).rejects.toThrow('ETIMEDOUT');
  });
});

describe('CatalogEventsListener.handle', () => {
  function listenerWith(update: jest.Mock): CatalogEventsListener {
    const { projection } = projectionWith(update);
    return new CatalogEventsListener({} as never, projection);
  }

  function event(eventType: string, body: unknown): DomainEvent {
    return {
      eventId: 'e-1',
      eventType,
      occurredAt: '2026-09-17T10:00:00.000Z',
      aggregateId: 'p-1',
      correlationId: 'corr',
      version: 1,
      payload: body,
    };
  }

  it('upserts on product.created and product.updated alike', async () => {
    const update = jest.fn(async () => ({ body: { result: 'updated' } }));
    const listener = listenerWith(update);

    await listener.handle(event('product.created', payload));
    await listener.handle(event('product.updated', { ...payload, version: 8 }));

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          script: expect.objectContaining({
            params: expect.objectContaining({ version: 8 }),
          }),
        }),
      }),
    );
  });

  it('handles product.rating_changed by applying ratings', async () => {
    const update = jest.fn(async () => ({ body: { result: 'updated' } }));
    const listener = listenerWith(update);

    await listener.handle(event('product.rating_changed', ratingPayload));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p-1',
        body: expect.objectContaining({
          script: expect.objectContaining({
            source: RATING_UPSERT_SCRIPT,
            params: {
              ratingAvgE2: 450,
              ratingCount: 2,
              version: 3,
            },
          }),
        }),
      }),
    );
  });

  it('never treats a category event as a product upsert', async () => {
    const update = jest.fn();
    const updateByQuery = jest.fn(async () => ({ body: { total: 0, updated: 0 } }));
    const client = { update, updateByQuery } as unknown as Client;
    const listener = new CatalogEventsListener(
      {} as never,
      new ProductsProjection(new OpenSearchClient(client)),
    );
    await listener.handle(
      event('category.updated', { id: 'c-1', slug: 'x', name: 'X', version: 2 }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(updateByQuery).toHaveBeenCalledTimes(1);
  });

  it('drops an unusable product payload instead of throwing', async () => {
    const update = jest.fn();
    await expect(
      listenerWith(update).handle(event('product.updated', { id: 'p-1' })),
    ).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('drops an unusable rating payload instead of throwing', async () => {
    const update = jest.fn();
    await expect(
      listenerWith(update).handle(event('product.rating_changed', { productId: 'p-1' })),
    ).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not throw on a stale product event, so the message is acked', async () => {
    const listener = listenerWith(
      jest.fn(async () => {
        throw conflict();
      }),
    );
    await expect(listener.handle(event('product.updated', payload))).resolves.toBeUndefined();
  });

  it('does not throw on a stale rating event, so the message is acked', async () => {
    const listener = listenerWith(jest.fn(async () => ({ body: { result: 'noop' } })));
    await expect(
      listener.handle(event('product.rating_changed', ratingPayload)),
    ).resolves.toBeUndefined();
  });
});
