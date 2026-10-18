import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateCatalogTranslations1735006000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. product_translations
    await queryRunner.createTable(
      new Table({
        name: 'product_translations',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'product_id', type: 'uuid', isNullable: false },
          { name: 'locale', type: 'varchar', length: '10', isNullable: false },
          { name: 'name', type: 'varchar', isNullable: false },
          { name: 'description', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
          { name: 'updated_at', type: 'timestamp', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'product_translations',
      new TableForeignKey({
        name: 'FK_product_translations_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'product_translations',
      new TableIndex({
        name: 'IDX_product_translations_product_locale',
        columnNames: ['product_id', 'locale'],
        isUnique: true,
      }),
    );

    // 2. category_translations
    await queryRunner.createTable(
      new Table({
        name: 'category_translations',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'category_id', type: 'uuid', isNullable: false },
          { name: 'locale', type: 'varchar', length: '10', isNullable: false },
          { name: 'name', type: 'varchar', isNullable: false },
          { name: 'description', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
          { name: 'updated_at', type: 'timestamp', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'category_translations',
      new TableForeignKey({
        name: 'FK_category_translations_category_id',
        columnNames: ['category_id'],
        referencedTableName: 'categories',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'category_translations',
      new TableIndex({
        name: 'IDX_category_translations_category_locale',
        columnNames: ['category_id', 'locale'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('category_translations');
    await queryRunner.dropTable('product_translations');
  }
}
