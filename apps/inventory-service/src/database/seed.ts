import 'reflect-metadata';
import { AppDataSource } from './typeorm.config';
import { StockEntity } from '../modules/stock/stock.entity';

/**
 * Seeds a stock row for every product in the catalog.
 *
 * Product ids live in the catalog service's database, which this service must
 * not read directly — that would couple two services through their storage and
 * defeat the point of separate databases. So the seed asks the catalog service
 * over HTTP, exactly as any other client would.
 *
 * From M3 onward this stops being necessary: inventory will learn about new
 * products from `product.created` events instead of asking.
 */
const CATALOG_URL = process.env.CATALOG_SERVICE_URL ?? 'http://catalog-service:3002';
const DEFAULT_QTY = Number(process.env.SEED_STOCK_QTY ?? 50);

interface CatalogProduct {
  id: string;
  sku: string;
}

async function fetchAllProducts(): Promise<CatalogProduct[]> {
  const all: CatalogProduct[] = [];
  let cursor: string | null = null;

  do {
    const url = new URL('/api/v1/catalog/products', CATALOG_URL);
    url.searchParams.set('limit', '100');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Catalog service returned ${response.status} for ${url.pathname}. ` +
          `Is it running and migrated? (CATALOG_SERVICE_URL=${CATALOG_URL})`,
      );
    }

    const page = (await response.json()) as { data: CatalogProduct[]; nextCursor: string | null };
    all.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  return all;
}

async function seed(): Promise<void> {
  const products = await fetchAllProducts();

  if (products.length === 0) {
    console.error('No products found. Seed the catalog service first.');
    process.exit(1);
  }

  await AppDataSource.initialize();
  console.log(`Connected. Seeding stock for ${products.length} products...`);

  const stock = AppDataSource.getRepository(StockEntity);
  let created = 0;
  let skipped = 0;

  for (const product of products) {
    const existing = await stock.findOne({ where: { productId: product.id } });

    // Idempotent, and deliberately non-destructive: an existing row may hold
    // real quantities or live reservations, so re-running never overwrites it.
    if (existing) {
      skipped++;
      continue;
    }

    await stock.save(stock.create({ productId: product.id, availableQty: DEFAULT_QTY }));
    console.log(`  ${product.sku.padEnd(12)} ${DEFAULT_QTY} units`);
    created++;
  }

  await AppDataSource.destroy();
  console.log(`\nInventory seed complete. ${created} created, ${skipped} already present.`);
}

seed().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
