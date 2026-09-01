import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreatePaymentsTables1735000600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await queryRunner.createTable(
      new Table({
        name: 'payments',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'order_id', type: 'uuid' },
          // The constraint that prevents double-charging. Sent to Stripe as its
          // Idempotency-Key; unique here so a second attempt cannot even be
          // recorded locally.
          { name: 'idempotency_key', type: 'varchar', isUnique: true },
          { name: 'provider', type: 'varchar', default: `'stripe'` },
          { name: 'provider_ref', type: 'varchar', isNullable: true },
          { name: 'client_secret', type: 'varchar', isNullable: true },
          { name: 'amount_minor', type: 'integer' },
          { name: 'currency', type: 'char', length: '3' },
          {
            name: 'status',
            type: 'enum',
            enum: ['requires_payment', 'authorized', 'declined', 'refunded'],
            default: `'requires_payment'`,
          },
          { name: 'failure_reason', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [{ name: 'CHK_payments_amount_positive', expression: '"amount_minor" > 0' }],
      }),
    );

    await queryRunner.createIndex(
      'payments',
      new TableIndex({ name: 'IDX_payments_order_id', columnNames: ['order_id'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'webhook_events',
        columns: [
          // Stripe's own event id as the primary key: a redelivery is a unique
          // violation, which is how duplicates are rejected without a race.
          { name: 'provider_event_id', type: 'varchar', isPrimary: true },
          { name: 'type', type: 'varchar' },
          { name: 'payload', type: 'jsonb' },
          { name: 'received_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'refunds',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'payment_id', type: 'uuid' },
          { name: 'idempotency_key', type: 'varchar', isUnique: true },
          { name: 'amount_minor', type: 'integer' },
          { name: 'reason', type: 'text', isNullable: true },
          { name: 'provider_ref', type: 'varchar', isNullable: true },
          { name: 'status', type: 'varchar', default: `'pending'` },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createIndex(
      'refunds',
      new TableIndex({ name: 'IDX_refunds_payment_id', columnNames: ['payment_id'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('refunds', 'IDX_refunds_payment_id');
    await queryRunner.dropTable('refunds');
    await queryRunner.dropTable('webhook_events');
    await queryRunner.dropIndex('payments', 'IDX_payments_order_id');
    await queryRunner.dropTable('payments');
  }
}
