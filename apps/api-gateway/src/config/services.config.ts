/**
 * Upstream service registry. Services not yet built are still listed so the
 * routing table has one obvious place to grow.
 */
export default () => ({
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET,

  // Proxy behaviour — the previous gateway had none of this, so a restarting
  // upstream surfaced as an unhandled 500.
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 5000),
  upstreamRetries: Number(process.env.UPSTREAM_RETRIES ?? 2),

  // R1
  usersServiceUrl: process.env.USERS_SERVICE_URL ?? 'http://users-service:3001',
  catalogServiceUrl: process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002',
  inventoryServiceUrl: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003',
  ordersServiceUrl: process.env.ORDERS_SERVICE_URL ?? 'http://orders-service:3004',
  paymentsServiceUrl: process.env.PAYMENTS_SERVICE_URL ?? 'http://payments-service:3005',

  // R2+ — not built yet
  cartServiceUrl: process.env.CART_SERVICE_URL ?? 'http://cart-service:3006',
  pricingServiceUrl: process.env.PRICING_SERVICE_URL ?? 'http://pricing-service:3007',
  shippingServiceUrl: process.env.SHIPPING_SERVICE_URL ?? 'http://shipping-service:3008',
  searchServiceUrl: process.env.SEARCH_SERVICE_URL ?? 'http://search-service:3009',
  reviewsServiceUrl: process.env.REVIEWS_SERVICE_URL ?? 'http://reviews-service:3010',
});
