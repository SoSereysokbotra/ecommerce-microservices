export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.USERS_DATABASE_URL,
});
