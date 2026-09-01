import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OutboxEventEntity, ProcessedEventEntity } from '@libs/outbox';
import { StockEntity } from '../modules/stock/stock.entity';
import { ReservationEntity } from '../modules/stock/reservation.entity';

loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(__dirname, '../../.env'), override: true });

function resolveSsl(
  databaseUrl: string | undefined,
  getEnv: (key: string) => string | undefined,
): boolean | { rejectUnauthorized: boolean } {
  const explicitSsl = getEnv('DATABASE_SSL');
  const rejectUnauthorized = (getEnv('DB_SSL_REJECT_UNAUTHORIZED') ?? 'false') !== 'false';

  if (explicitSsl) {
    return ['1', 'true', 'yes', 'require'].includes(explicitSsl.toLowerCase())
      ? { rejectUnauthorized }
      : false;
  }

  if (!databaseUrl) {
    return false;
  }

  try {
    const parsed = new URL(databaseUrl);
    const sslMode = parsed.searchParams.get('sslmode');
    const requiresSsl =
      parsed.hostname.endsWith('.neon.tech') ||
      ['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '');

    return requiresSsl ? { rejectUnauthorized } : false;
  } catch {
    return false;
  }
}

export function typeOrmConfig(config?: ConfigService): DataSourceOptions {
  const isProduction = (config?.get('NODE_ENV') ?? process.env.NODE_ENV) === 'production';
  const getEnv = (k: string) => (config ? config.get<string>(k) : process.env[k]);

  const explicitDatabaseUrl = getEnv('DATABASE_URL');
  const DATABASE_URL = explicitDatabaseUrl ?? getEnv('INVENTORY_DATABASE_URL');
  const localPassword = getEnv('POSTGRES_PASSWORD') || 'postgres';
  const ssl = resolveSsl(DATABASE_URL, getEnv);

  if (!DATABASE_URL) {
    if (isProduction) {
      throw new Error('DATABASE_URL must be set in production');
    }
    const DB_HOST = getEnv('DB_HOST');
    const DB_NAME = getEnv('DB_NAME');
    if (!DB_HOST || !DB_NAME) {
      throw new Error('DATABASE_URL or DB_HOST+DB_NAME must be set');
    }

    const DB_PORT = getEnv('DB_PORT') ?? '5432';
    const DB_USER = getEnv('DB_USER') ?? 'postgres';
    const DB_PASSWORD = getEnv('DB_PASSWORD') ?? localPassword;

    return {
      type: 'postgres',
      host: DB_HOST,
      port: Number(DB_PORT),
      username: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      entities: [StockEntity, ReservationEntity, OutboxEventEntity, ProcessedEventEntity],
      migrations: [__dirname + '/migrations/*{.ts,.js}'],
      synchronize: false,
      logging: !isProduction,
      migrationsRun: getEnv('TYPEORM_MIGRATIONS_RUN')
        ? getEnv('TYPEORM_MIGRATIONS_RUN') === 'true'
        : isProduction,
      ssl,
    };
  }

  if (!explicitDatabaseUrl && DATABASE_URL) {
    const parsed = new URL(DATABASE_URL);

    return {
      type: 'postgres',
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      username: parsed.username || 'postgres',
      password: parsed.password || localPassword,
      database: parsed.pathname.replace(/^\//, ''),
      entities: [StockEntity, ReservationEntity, OutboxEventEntity, ProcessedEventEntity],
      migrations: [__dirname + '/migrations/*{.ts,.js}'],
      synchronize: false,
      logging: !isProduction,
      migrationsRun: getEnv('TYPEORM_MIGRATIONS_RUN')
        ? getEnv('TYPEORM_MIGRATIONS_RUN') === 'true'
        : isProduction,
      ssl,
    };
  }

  return {
    type: 'postgres',
    url: DATABASE_URL,
    entities: [StockEntity, ReservationEntity, OutboxEventEntity, ProcessedEventEntity],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    synchronize: false,
    logging: !isProduction,
    migrationsRun: getEnv('TYPEORM_MIGRATIONS_RUN')
      ? getEnv('TYPEORM_MIGRATIONS_RUN') === 'true'
      : isProduction,
    ssl,
  };
}

export const AppDataSource = new DataSource(typeOrmConfig());
