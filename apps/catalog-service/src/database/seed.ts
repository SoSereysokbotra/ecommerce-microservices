import 'reflect-metadata';
import { AppDataSource } from './typeorm.config';
import { CategoryEntity } from '../modules/categories/category.entity';
import { ProductEntity } from '../modules/products/product.entity';

/**
 * Idempotent seed — safe to re-run. Matches on the natural key (slug / sku)
 * and updates rather than inserting duplicates.
 *
 * Prices are integer minor units in USD. 1999 = $19.99.
 */
const CATEGORIES = [
  { slug: 'apparel', name: 'Apparel', description: 'Shirts, hoodies and hats' },
  { slug: 'drinkware', name: 'Drinkware', description: 'Mugs and bottles' },
  { slug: 'accessories', name: 'Accessories', description: 'Bags, stickers and cables' },
];

const PRODUCTS = [
  {
    sku: 'TSH-BLK-S',
    slug: 'black-tee-small',
    name: 'Black Tee (S)',
    priceMinor: 1999,
    category: 'apparel',
    description: 'Combed cotton, regular fit.',
  },
  {
    sku: 'TSH-BLK-M',
    slug: 'black-tee-medium',
    name: 'Black Tee (M)',
    priceMinor: 1999,
    category: 'apparel',
    description: 'Combed cotton, regular fit.',
  },
  {
    sku: 'TSH-BLK-L',
    slug: 'black-tee-large',
    name: 'Black Tee (L)',
    priceMinor: 1999,
    category: 'apparel',
    description: 'Combed cotton, regular fit.',
  },
  {
    sku: 'HOD-GRY-M',
    slug: 'grey-hoodie-medium',
    name: 'Grey Hoodie (M)',
    priceMinor: 4950,
    category: 'apparel',
    description: 'Brushed fleece lining.',
  },
  {
    sku: 'HOD-GRY-L',
    slug: 'grey-hoodie-large',
    name: 'Grey Hoodie (L)',
    priceMinor: 4950,
    category: 'apparel',
    description: 'Brushed fleece lining.',
  },
  {
    sku: 'CAP-NVY-1',
    slug: 'navy-cap',
    name: 'Navy Cap',
    priceMinor: 2250,
    category: 'apparel',
    description: 'Six-panel, adjustable strap.',
  },
  {
    sku: 'MUG-WHT-1',
    slug: 'white-mug',
    name: 'White Mug',
    priceMinor: 1250,
    category: 'drinkware',
    description: '325ml ceramic, dishwasher safe.',
  },
  {
    sku: 'MUG-BLK-1',
    slug: 'black-mug',
    name: 'Black Mug',
    priceMinor: 1250,
    category: 'drinkware',
    description: '325ml ceramic, dishwasher safe.',
  },
  {
    sku: 'BTL-STL-1',
    slug: 'steel-bottle',
    name: 'Steel Bottle',
    priceMinor: 3400,
    category: 'drinkware',
    description: '750ml vacuum insulated.',
  },
  {
    sku: 'BAG-CVS-1',
    slug: 'canvas-tote',
    name: 'Canvas Tote',
    priceMinor: 1800,
    category: 'accessories',
    description: 'Heavy cotton canvas.',
  },
  {
    sku: 'STK-PCK-1',
    slug: 'sticker-pack',
    name: 'Sticker Pack',
    priceMinor: 600,
    category: 'accessories',
    description: 'Ten vinyl stickers.',
  },
  {
    sku: 'CBL-USB-1',
    slug: 'usb-c-cable',
    name: 'USB-C Cable',
    priceMinor: 1400,
    category: 'accessories',
    description: 'Braided, 2 metres, 100W.',
  },
];

async function seed(): Promise<void> {
  await AppDataSource.initialize();
  console.log('Connected. Seeding catalog...');

  const categories = AppDataSource.getRepository(CategoryEntity);
  const products = AppDataSource.getRepository(ProductEntity);

  const idBySlug = new Map<string, string>();

  for (const input of CATEGORIES) {
    const existing = await categories.findOne({ where: { slug: input.slug } });
    const saved = await categories.save(
      existing ? Object.assign(existing, input) : categories.create(input),
    );
    idBySlug.set(saved.slug, saved.id);
  }
  console.log(`  ${CATEGORIES.length} categories`);

  for (const { category, ...input } of PRODUCTS) {
    const existing = await products.findOne({ where: { sku: input.sku } });
    await products.save(
      existing
        ? Object.assign(existing, input, { categoryId: idBySlug.get(category) ?? null })
        : products.create({
            ...input,
            currency: 'USD',
            active: true,
            categoryId: idBySlug.get(category) ?? null,
          }),
    );
  }
  console.log(`  ${PRODUCTS.length} products`);

  // Printed so the inventory seed can be pointed at the same ids.
  const seeded = await products.find({ select: ['id', 'sku'], order: { sku: 'ASC' } });
  console.log('\nProduct ids (use these to seed inventory):');
  for (const p of seeded) {
    console.log(`  ${p.sku}  ${p.id}`);
  }

  await AppDataSource.destroy();
  console.log('\nCatalog seed complete.');
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
