export const paymentsConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.PAYMENTS_DATABASE_URL,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
});
