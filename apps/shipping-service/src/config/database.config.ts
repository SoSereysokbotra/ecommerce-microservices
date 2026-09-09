export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.SHIPPING_DATABASE_URL,

  /**
   * The currency every rate is quoted in.
   *
   * Rates carry their own `currency` column, but nothing in this project is
   * multi-currency until M11, so a mismatch between a rate and the basket it is
   * priced into is a seeding mistake rather than a supported case. This is what
   * the service assumes and what the seed writes.
   */
  currency: process.env.SHIPPING_CURRENCY ?? 'USD',
});
