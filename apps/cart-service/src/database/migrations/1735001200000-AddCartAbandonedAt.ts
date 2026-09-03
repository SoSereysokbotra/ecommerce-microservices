import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Records that `cart.abandoned` has already been emitted for a cart.
 *
 * Without it the sweep would re-emit for the same cart on every tick, because
 * "not touched since the cutoff" stays true forever. Cleared whenever the cart
 * is touched again, so a shopper who comes back and later drifts off is flagged
 * a second time rather than never again.
 */
export class AddCartAbandonedAt1735001200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'carts',
      new TableColumn({ name: 'abandoned_at', type: 'timestamptz', isNullable: true }),
    );

    // The sweep's query: unflagged carts older than the cutoff.
    await queryRunner.createIndex(
      'carts',
      new TableIndex({
        name: 'IDX_carts_abandoned_sweep',
        columnNames: ['abandoned_at', 'updated_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('carts', 'IDX_carts_abandoned_sweep');
    await queryRunner.dropColumn('carts', 'abandoned_at');
  }
}
