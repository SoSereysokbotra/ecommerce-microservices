import { AdminController } from '../src/modules/recommendations/admin.controller';
import { RecommendationsService } from '../src/modules/recommendations/recommendations.service';

describe('AdminController & reset', () => {
  it('reset() delegates to service and returns clear status with next replay command', async () => {
    const recommendationsMock = {
      reset: jest.fn(async () => undefined),
    };

    const controller = new AdminController(
      recommendationsMock as unknown as RecommendationsService,
    );
    const result = await controller.reset();

    expect(recommendationsMock.reset).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      cleared: true,
      next: 'POST /orders/admin/replay-co-purchases',
    });
  });

  it('RecommendationsService.reset runs TRUNCATE and deletes idempotency markers inside a transaction', async () => {
    const executedQueries: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executedQueries.push(sql);
        return [];
      }),
    };

    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
      query: jest.fn(),
    };

    const catalogClient = {} as never;
    const service = new RecommendationsService(dataSource as never, catalogClient);

    await service.reset();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(executedQueries).toEqual([
      'TRUNCATE TABLE product_recommendations',
      "DELETE FROM processed_events WHERE consumer = 'recommendations-service'",
    ]);
  });
});
