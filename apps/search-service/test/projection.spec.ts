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
import { ProductsProjection } from '../src/modules/search/products.projection';

/**
 * The projection, without a cluster or a broker.
 *
 * Three things matter, in the order docs/M12_SEARCH_PLAN.md §8 lists them:
 * the event-to-document function (including an inactive product and one with
 * no category), the write going out with `version_type: external`, and the
 * 409 being **swallowed** — a version conflict rethrown would nack the
 * message with `requeue=false`, and the bus would drop an event that was
 * never wrong.
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
    const mapped = Object.keys(PRODUCTS_INDEX_BODY.mappings.properties).sort();
    expect(Object.keys(toProductDocument(payload)).sort()).toEqual(mapped);
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

function projectionWith(indexImpl: jest.Mock): {
  projection: ProductsProjection;
  index: jest.Mock;
} {
  const client = { index: indexImpl } as unknown as Client;
  return { projection: new ProductsProjection(new OpenSearchClient(client)), index: indexImpl };
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
  it('writes with external versioning keyed on the event version', async () => {
    const { projection, index } = projectionWith(jest.fn(async () => ({ body: {} })));
    const doc = toProductDocument(payload);

    await expect(projection.upsert(doc)).resolves.toBe('written');

    expect(index).toHaveBeenCalledWith(
      expect.objectContaining({
        index: PRODUCTS_INDEX,
        id: 'p-1',
        version: 7,
        version_type: 'external',
        body: doc,
      }),
    );
  });

  it('treats a version conflict as success, not as a failure to retry', async () => {
    const { projection } = projectionWith(
      jest.fn(async () => {
        throw conflict();
      }),
    );

    await expect(projection.upsert(toProductDocument(payload))).resolves.toBe('stale');
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

describe('CatalogEventsListener.handle', () => {
  function listenerWith(index: jest.Mock): CatalogEventsListener {
    const { projection } = projectionWith(index);
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
    const index = jest.fn(async () => ({ body: {} }));
    const listener = listenerWith(index);

    await listener.handle(event('product.created', payload));
    await listener.handle(event('product.updated', { ...payload, version: 8 }));

    expect(index).toHaveBeenCalledTimes(2);
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({ version: 8 }));
  });

  it('ignores category events for now', async () => {
    const index = jest.fn();
    await listenerWith(index).handle(event('category.updated', { id: 'c-1', version: 2 }));
    expect(index).not.toHaveBeenCalled();
  });

  it('drops an unusable payload instead of throwing', async () => {
    const index = jest.fn();
    await expect(
      listenerWith(index).handle(event('product.updated', { id: 'p-1' })),
    ).resolves.toBeUndefined();
    expect(index).not.toHaveBeenCalled();
  });

  it('does not throw on a stale event, so the message is acked', async () => {
    const listener = listenerWith(
      jest.fn(async () => {
        throw conflict();
      }),
    );
    await expect(listener.handle(event('product.updated', payload))).resolves.toBeUndefined();
  });
});
