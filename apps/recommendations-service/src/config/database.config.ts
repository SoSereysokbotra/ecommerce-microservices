export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.RECOMMENDATIONS_DATABASE_URL,
});
