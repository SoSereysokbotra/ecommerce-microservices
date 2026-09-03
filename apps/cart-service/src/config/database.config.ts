export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.CART_DATABASE_URL,
});
