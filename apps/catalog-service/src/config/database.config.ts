export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.CATALOG_DATABASE_URL,
});
