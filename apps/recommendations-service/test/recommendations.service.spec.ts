import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  RecommendationsService,
  SELECT_RECOMMENDATIONS_SQL,
  UPSERT_CO_PURCHASE_SQL,
} from '../src/modules/recommendations/recommendations.service';
import { CatalogClient } from '../src/modules/recommendations/catalog.client';

describe('RecommendationsService', () => {
  let service: RecommendationsService;
  let dataSourceMock: jest.Mocked<DataSource>;
  let catalogClientMock: jest.Mocked<CatalogClient>;
  let managerMock: jest.Mocked<EntityManager>;

  beforeEach(() => {
    dataSourceMock = {
      // dataSource.query returns snake_case column names, never entity properties.
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DataSource>;

    catalogClientMock = {
      getProductsByIds: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CatalogClient>;

    managerMock = {
      // manager.query returns snake_case column names, never entity properties.
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<EntityManager>;

    service = new RecommendationsService(dataSourceMock, catalogClientMock);
  });

  describe('recordCoPurchases', () => {
    it('builds the right SQL and parameters for a 2-item basket', async () => {
      const items = [{ productId: 'prod-a' }, { productId: 'prod-b' }];

      const count = await service.recordCoPurchases(managerMock, items);

      expect(count).toBe(2);
      expect(managerMock.query).toHaveBeenCalledTimes(2);

      expect(managerMock.query).toHaveBeenNthCalledWith(1, UPSERT_CO_PURCHASE_SQL, [
        'prod-a',
        'prod-b',
      ]);
      expect(managerMock.query).toHaveBeenNthCalledWith(2, UPSERT_CO_PURCHASE_SQL, [
        'prod-b',
        'prod-a',
      ]);
    });

    it('builds the right SQL and parameters for a 3-item basket', async () => {
      const items = [{ productId: 'prod-a' }, { productId: 'prod-b' }, { productId: 'prod-c' }];

      const count = await service.recordCoPurchases(managerMock, items);

      expect(count).toBe(6);
      expect(managerMock.query).toHaveBeenCalledTimes(6);

      const calls = managerMock.query.mock.calls;
      const parameters = calls.map((call) => call[1]);

      expect(parameters).toEqual([
        ['prod-a', 'prod-b'],
        ['prod-a', 'prod-c'],
        ['prod-b', 'prod-a'],
        ['prod-b', 'prod-c'],
        ['prod-c', 'prod-a'],
        ['prod-c', 'prod-b'],
      ]);

      for (const call of calls) {
        expect(call[0]).toBe(UPSERT_CO_PURCHASE_SQL);
      }
    });

    it('deduplicates lines of the same product before building SQL statements', async () => {
      const items = [{ productId: 'prod-a' }, { productId: 'prod-b' }, { productId: 'prod-a' }];

      const count = await service.recordCoPurchases(managerMock, items);

      expect(count).toBe(2);
      expect(managerMock.query).toHaveBeenCalledTimes(2);
      expect(managerMock.query).toHaveBeenNthCalledWith(1, UPSERT_CO_PURCHASE_SQL, [
        'prod-a',
        'prod-b',
      ]);
      expect(managerMock.query).toHaveBeenNthCalledWith(2, UPSERT_CO_PURCHASE_SQL, [
        'prod-b',
        'prod-a',
      ]);
    });

    it('returns 0 and does not execute queries for empty or single-item baskets', async () => {
      expect(await service.recordCoPurchases(managerMock, [])).toBe(0);
      expect(await service.recordCoPurchases(managerMock, [{ productId: 'prod-a' }])).toBe(0);
      expect(managerMock.query).not.toHaveBeenCalled();
    });
  });

  describe('getRecommendations', () => {
    it('queries top rows with co_purchase_count DESC and stable tiebreak', async () => {
      // Mock returns snake_case column names as the real Postgres driver does
      dataSourceMock.query.mockResolvedValue([
        { recommended_product_id: 'rec-1', co_purchase_count: 10 },
        { recommended_product_id: 'rec-2', co_purchase_count: 5 },
      ]);

      catalogClientMock.getProductsByIds.mockResolvedValue([
        {
          id: 'rec-1',
          sku: 'SKU-1',
          slug: 'product-1',
          name: 'Product 1',
          priceMinor: 1000,
          currency: 'USD',
          active: true,
        },
        {
          id: 'rec-2',
          sku: 'SKU-2',
          slug: 'product-2',
          name: 'Product 2',
          priceMinor: 2000,
          currency: 'USD',
          active: true,
        },
      ]);

      const result = await service.getRecommendations('prod-target', 4, 'corr-xyz');

      expect(dataSourceMock.query).toHaveBeenCalledWith(SELECT_RECOMMENDATIONS_SQL, [
        'prod-target',
        4,
      ]);
      expect(catalogClientMock.getProductsByIds).toHaveBeenCalledWith(
        ['rec-1', 'rec-2'],
        'corr-xyz',
      );

      expect(result).toEqual({
        items: [
          {
            productId: 'rec-1',
            sku: 'SKU-1',
            slug: 'product-1',
            name: 'Product 1',
            priceMinor: 1000,
            currency: 'USD',
            coPurchaseCount: 10,
          },
          {
            productId: 'rec-2',
            sku: 'SKU-2',
            slug: 'product-2',
            name: 'Product 2',
            priceMinor: 2000,
            currency: 'USD',
            coPurchaseCount: 5,
          },
        ],
        total: 2,
      });
    });

    it('drops missing or inactive products from the enriched result', async () => {
      dataSourceMock.query.mockResolvedValue([
        { recommended_product_id: 'rec-active', co_purchase_count: 8 },
        { recommended_product_id: 'rec-inactive', co_purchase_count: 6 },
        { recommended_product_id: 'rec-missing', co_purchase_count: 4 },
      ]);

      catalogClientMock.getProductsByIds.mockResolvedValue([
        {
          id: 'rec-active',
          sku: 'SKU-ACT',
          slug: 'product-active',
          name: 'Active Product',
          priceMinor: 1500,
          currency: 'USD',
          active: true,
        },
        {
          id: 'rec-inactive',
          sku: 'SKU-INACT',
          slug: 'product-inactive',
          name: 'Inactive Product',
          priceMinor: 2500,
          currency: 'USD',
          active: false, // inactive!
        },
      ]);

      const result = await service.getRecommendations('prod-target');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        productId: 'rec-active',
        sku: 'SKU-ACT',
        slug: 'product-active',
        name: 'Active Product',
        priceMinor: 1500,
        currency: 'USD',
        coPurchaseCount: 8,
      });
      expect(result.total).toBe(1);
    });

    it('returns an empty result { items: [], total: 0 } for an unknown id without error', async () => {
      dataSourceMock.query.mockResolvedValue([]);

      const result = await service.getRecommendations('prod-unknown');

      expect(result).toEqual({ items: [], total: 0 });
      expect(catalogClientMock.getProductsByIds).not.toHaveBeenCalled();
    });

    it('propagates 503 when catalog-service is unreachable', async () => {
      dataSourceMock.query.mockResolvedValue([
        { recommended_product_id: 'rec-1', co_purchase_count: 10 },
      ]);

      catalogClientMock.getProductsByIds.mockRejectedValue(
        new ServiceUnavailableException('catalog-service unreachable: connection refused'),
      );

      await expect(service.getRecommendations('prod-target')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
