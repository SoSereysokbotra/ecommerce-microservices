export const databaseConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.REVIEWS_DATABASE_URL,

  /**
   * users-service, for the author's name at review time. A review shows a
   * name; the gateway forwards an id and a role, and the browser cannot be
   * trusted to supply one. The name is snapshotted onto the review the way
   * orders snapshots an address (M10), so renaming an account does not
   * rewrite old reviews.
   */
  usersServiceUrl: process.env.USERS_SERVICE_URL ?? 'http://users-service:3001',
});
