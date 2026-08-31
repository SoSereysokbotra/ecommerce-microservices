export const servicesConfig = () => ({
  databaseUrl: process.env.DATABASE_URL ?? process.env.ORDERS_DATABASE_URL,

  // M2 calls these synchronously over HTTP. M3 replaces them with events.
  catalogServiceUrl: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
  inventoryServiceUrl: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003',
  paymentsServiceUrl: process.env.PAYMENTS_SERVICE_URL ?? 'http://payments-service:3005',
});
