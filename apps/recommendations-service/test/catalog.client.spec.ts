import { ServiceUnavailableException } from '@nestjs/common';
import { CatalogClient } from '../src/modules/recommendations/catalog.client';

describe('CatalogClient', () => {
  let client: CatalogClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new CatalogClient();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns empty array when productIds is empty without issuing a request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const result = await client.getProductsByIds([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches products in one bulk request and returns parsed data', async () => {
    const products = [
      {
        id: 'p-1',
        sku: 'SKU-1',
        slug: 'p-1',
        name: 'Product 1',
        priceMinor: 1000,
        currency: 'USD',
        active: true,
      },
      {
        id: 'p-2',
        sku: 'SKU-2',
        slug: 'p-2',
        name: 'Product 2',
        priceMinor: 2000,
        currency: 'USD',
        active: true,
      },
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: products, nextCursor: null }),
    });

    const result = await client.getProductsByIds(['p-1', 'p-2'], 'corr-test');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/catalog/products?ids=p-1,p-2'),
      expect.objectContaining({
        headers: { 'x-correlation-id': 'corr-test' },
      }),
    );
    expect(result).toEqual(products);
  });

  it('throws 503 ServiceUnavailableException when catalog returns 5xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ message: 'Bad Gateway' }),
    });

    await expect(client.getProductsByIds(['p-1'])).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws 503 ServiceUnavailableException when network request fails or times out', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED'));

    await expect(client.getProductsByIds(['p-1'])).rejects.toThrow(ServiceUnavailableException);
  });
});
