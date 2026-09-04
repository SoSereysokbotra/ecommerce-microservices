export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.PRICING_DATABASE_URL,
  catalogServiceUrl: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',

  // Where a quote is taxed when the caller does not say. Addresses arrive in
  // M10; until then the destination travels on the request, and this is the
  // fallback — see docs/M8_PRICING_PLAN.md §5.
  defaultTaxCountry: process.env.DEFAULT_TAX_COUNTRY ?? 'US',
  defaultTaxRegion: process.env.DEFAULT_TAX_REGION ?? 'CA',
});
