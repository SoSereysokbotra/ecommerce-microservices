import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Checkout stopped being synchronous in M3, so an order now has states between
 * "created" and "done": it waits for inventory, then for payment.
 */
export class AddOrderStatuses1735000500000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "orders_status_enum" ADD VALUE IF NOT EXISTS 'awaiting_payment'`,
    );
    await queryRunner.query(`ALTER TYPE "orders_status_enum" ADD VALUE IF NOT EXISTS 'cancelled'`);
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum type. Reversing this means
    // recreating the type and rewriting the column, which is not worth doing
    // for two additive values that nothing depends on removing.
  }
}
