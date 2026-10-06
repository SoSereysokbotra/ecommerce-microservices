export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.RECOMMENDATIONS_DATABASE_URL,
  catalogServiceUrl: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
});
