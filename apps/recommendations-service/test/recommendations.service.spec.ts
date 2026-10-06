import { EntityManager } from 'typeorm';
import {
  RecommendationsService,
  UPSERT_CO_PURCHASE_SQL,
} from '../src/modules/recommendations/recommendations.service';

describe('RecommendationsService', () => {
  let service: RecommendationsService;
  let managerMock: jest.Mocked<EntityManager>;

  beforeEach(() => {
    service = new RecommendationsService();
    managerMock = {
      // manager.query returns snake_case column names, never entity properties.
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<EntityManager>;
  });

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
