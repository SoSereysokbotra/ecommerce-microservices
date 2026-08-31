import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateProductsTable1735000100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'products',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'sku', type: 'varchar', isUnique: true },
          { name: 'slug', type: 'varchar', isUnique: true },
          { name: 'name', type: 'varchar' },
          { name: 'description', type: 'text', isNullable: true },
          // Integer minor units. See ProductEntity for why this is not numeric.
          { name: 'price_minor', type: 'integer' },
          { name: 'currency', type: 'char', length: '3' },
          { name: 'category_id', type: 'uuid', isNullable: true },
          { name: 'active', type: 'boolean', default: true },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
          { name: 'updated_at', type: 'timestamp', default: 'now()' },
        ],
      }),
    );

    // No foreign key to categories: it is in the same database today, but the
    // listing query filters on this column constantly and an index is what that
    // needs. Referential integrity across aggregates is enforced in the service.
    await queryRunner.createIndex(
      'products',
      new TableIndex({ name: 'IDX_products_category_id', columnNames: ['category_id'] }),
    );
    await queryRunner.createIndex(
      'products',
      new TableIndex({ name: 'IDX_products_active', columnNames: ['active'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('products', 'IDX_products_active');
    await queryRunner.dropIndex('products', 'IDX_products_category_id');
    await queryRunner.dropTable('products');
  }
}
