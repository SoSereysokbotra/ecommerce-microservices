import { Client, errors } from '@opensearch-project/opensearch';
import { OpenSearchClient } from '../src/modules/search/opensearch.client';
import { PRODUCTS_INDEX, PRODUCTS_INDEX_BODY } from '../src/modules/search/products.index';

/**
 * The index bootstrap, against a fake client. No cluster.
 *
 * Three things matter: the index is created with *this* mapping when absent,
 * it is left alone when present, and losing a race to create it is not an
 * error — two instances booting together must both come up.
 */
function fakeClient(overrides: {
  exists?: boolean;
  createError?: unknown;
  health?: string;
  healthError?: unknown;
}): { client: Client; create: jest.Mock } {
  const create = jest.fn(async () => {
    if (overrides.createError) {
      throw overrides.createError;
    }
    return { body: { acknowledged: true } };
  });
  const client = {
    indices: {
      exists: jest.fn(async () => ({ body: overrides.exists ?? false })),
      create,
    },
    cluster: {
      health: jest.fn(async () => {
        if (overrides.healthError) {
          throw overrides.healthError;
        }
        return { body: { status: overrides.health ?? 'green' } };
      }),
    },
  } as unknown as Client;
  return { client, create };
}

function responseError(type: string, statusCode: number): errors.ResponseError {
  return new errors.ResponseError({
    body: { error: { type } },
    statusCode,
    headers: {},
    warnings: null,
    meta: {} as never,
  });
}

describe('OpenSearchClient.ensureIndex', () => {
  it('creates the products index with the mapping when it is missing', async () => {
    const { client, create } = fakeClient({ exists: false });

    await expect(new OpenSearchClient(client).ensureIndex()).resolves.toBe('created');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ index: PRODUCTS_INDEX, body: PRODUCTS_INDEX_BODY });
  });

  it('leaves an existing index alone', async () => {
    const { client, create } = fakeClient({ exists: true });

    await expect(new OpenSearchClient(client).ensureIndex()).resolves.toBe('exists');

    expect(create).not.toHaveBeenCalled();
  });

  it('treats losing the create race as "exists"', async () => {
    const { client } = fakeClient({
      exists: false,
      createError: responseError('resource_already_exists_exception', 400),
    });

    await expect(new OpenSearchClient(client).ensureIndex()).resolves.toBe('exists');
  });

  it('rethrows any other create failure', async () => {
    const { client } = fakeClient({
      exists: false,
      createError: responseError('illegal_argument_exception', 400),
    });

    await expect(new OpenSearchClient(client).ensureIndex()).rejects.toBeInstanceOf(
      errors.ResponseError,
    );
  });

  it('boots without throwing when the cluster is unreachable', async () => {
    const { client } = fakeClient({ exists: false, createError: new Error('ECONNREFUSED') });
    // `exists` is what fails first on a dead cluster; make it fail too.
    (client.indices.exists as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(new OpenSearchClient(client).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('OpenSearchClient.recreateIndex', () => {
  it('drops the index (tolerating its absence) and creates it with the mapping', async () => {
    const del = jest.fn(async () => ({ body: { acknowledged: true } }));
    const { client, create } = fakeClient({ exists: true });
    (client.indices as unknown as { delete: jest.Mock }).delete = del;

    await new OpenSearchClient(client).recreateIndex();

    expect(del).toHaveBeenCalledWith({ index: PRODUCTS_INDEX }, { ignore: [404] });
    expect(create).toHaveBeenCalledWith({ index: PRODUCTS_INDEX, body: PRODUCTS_INDEX_BODY });
    expect(del.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });
});

describe('OpenSearchClient.clusterStatus', () => {
  it('returns the status the cluster reports', async () => {
    const { client } = fakeClient({ health: 'yellow' });
    await expect(new OpenSearchClient(client).clusterStatus()).resolves.toBe('yellow');
  });

  it('throws when the cluster cannot be reached', async () => {
    const { client } = fakeClient({ healthError: new Error('ECONNREFUSED') });
    await expect(new OpenSearchClient(client).clusterStatus()).rejects.toThrow('ECONNREFUSED');
  });
});

describe('products index mapping', () => {
  it('is strict, so an unmapped event field fails the write instead of guessing a type', () => {
    expect(PRODUCTS_INDEX_BODY.mappings.dynamic).toBe('strict');
  });

  it('has no replicas, so a single node is green rather than permanently yellow', () => {
    expect(PRODUCTS_INDEX_BODY.settings.number_of_replicas).toBe(0);
  });

  it('maps every field of the §6 document and nothing else', () => {
    expect(Object.keys(PRODUCTS_INDEX_BODY.mappings.properties).sort()).toEqual(
      [
        'active',
        'categoryId',
        'categoryName',
        'categorySlug',
        'categoryVersion',
        'currency',
        'description',
        'exponent',
        'id',
        'name',
        'priceMinor',
        'sku',
        'slug',
        'updatedAt',
        'version',
        'weightGrams',
      ].sort(),
    );
  });
});
