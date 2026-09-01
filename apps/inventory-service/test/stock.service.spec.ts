import { ConflictException, NotFoundException } from '@nestjs/common';
import { StockService } from '../src/modules/stock/stock.service';
import { StockEntity } from '../src/modules/stock/stock.entity';

/**
 * Reservation rules, tested against a fake EntityManager.
 *
 * These are the invariants the saga will lean on in M5: a reservation either
 * takes every line or none of them, and it never drives stock negative.
 */
describe('StockService.reserveWithManager', () => {
  const makeRow = (productId: string, available: number, reserved = 0): StockEntity =>
    Object.assign(new StockEntity(), {
      productId,
      availableQty: available,
      reservedQty: reserved,
      version: 1,
      updatedAt: new Date(),
    });

  function managerFor(rows: StockEntity[]) {
    const saved: StockEntity[] = [];
    return {
      saved,
      manager: {
        getRepository: () => ({
          findOne: async ({ where }: { where: { productId: string } }) =>
            rows.find((r) => r.productId === where.productId) ?? null,
          save: async (row: StockEntity) => {
            saved.push(row);
            return row;
          },
        }),
      },
    };
  }

  const service = new StockService(null as never, null as never);

  it('moves quantity from available to reserved', async () => {
    const rows = [makeRow('p1', 10)];
    const { manager } = managerFor(rows);

    const result = await service.reserveWithManager(manager as never, [
      { productId: 'p1', qty: 3 },
    ]);

    expect(result[0].availableQty).toBe(7);
    expect(result[0].reservedQty).toBe(3);
  });

  it('rejects a reservation larger than available stock', async () => {
    const rows = [makeRow('p1', 2)];
    const { manager } = managerFor(rows);

    await expect(
      service.reserveWithManager(manager as never, [{ productId: 'p1', qty: 5 }]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('names the missing product when there is no stock record', async () => {
    const { manager } = managerFor([]);

    await expect(
      service.reserveWithManager(manager as never, [{ productId: 'ghost', qty: 1 }]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws before touching later lines when an earlier one is short', async () => {
    // The caller runs this inside a transaction, so throwing is what makes the
    // reservation all-or-nothing. If it returned partial success instead, the
    // first line would stay reserved for an order that cannot be fulfilled.
    const rows = [makeRow('p1', 1), makeRow('p2', 100)];
    const { manager } = managerFor(rows);

    await expect(
      service.reserveWithManager(manager as never, [
        { productId: 'p1', qty: 5 },
        { productId: 'p2', qty: 1 },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(rows[1].reservedQty).toBe(0);
  });
});
