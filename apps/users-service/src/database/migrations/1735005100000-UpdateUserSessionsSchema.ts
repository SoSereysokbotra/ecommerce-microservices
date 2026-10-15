import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateUserSessionsSchema1735005100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'refresh_token')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'token_hash') THEN
          ALTER TABLE user_sessions RENAME COLUMN refresh_token TO token_hash;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'token_hash') THEN
          ALTER TABLE user_sessions ADD COLUMN token_hash VARCHAR;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'prev_token_hash') THEN
          ALTER TABLE user_sessions ADD COLUMN prev_token_hash VARCHAR;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'user_agent') THEN
          ALTER TABLE user_sessions ADD COLUMN user_agent VARCHAR;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'ip_address') THEN
          ALTER TABLE user_sessions ADD COLUMN ip_address VARCHAR;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'revoked_at') THEN
          ALTER TABLE user_sessions ADD COLUMN revoked_at TIMESTAMP;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'revocation_reason') THEN
          ALTER TABLE user_sessions ADD COLUMN revocation_reason VARCHAR;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'updated_at') THEN
          ALTER TABLE user_sessions ADD COLUMN updated_at TIMESTAMP DEFAULT now();
        END IF;
      END
      $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
