export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.INVENTORY_DATABASE_URL,
});
