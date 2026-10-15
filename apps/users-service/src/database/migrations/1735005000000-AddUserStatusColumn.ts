import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserStatusColumn1735005000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_status_enum') THEN
          CREATE TYPE users_status_enum AS ENUM ('active', 'suspended', 'banned');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS status users_status_enum DEFAULT 'active' NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS users_status_enum;`);
  }
}
