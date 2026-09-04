export const servicesConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.ORDERS_DATABASE_URL,

  // M3 replaced every state-changing call to these with events; the entries
  // remain because the URLs are still configured per environment.
  inventoryServiceUrl: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003',
  paymentsServiceUrl: process.env.PAYMENTS_SERVICE_URL ?? 'http://payments-service:3005',

  // The one synchronous call orders still makes, and the only one it needs: a
  // read before anything commits. M8 removed the catalog lookup that used to
  // sit beside it — pricing-service reads catalog itself now.
  pricingServiceUrl: process.env.PRICING_SERVICE_URL ?? 'http://pricing-service:3007',
});
