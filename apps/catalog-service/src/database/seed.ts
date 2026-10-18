import 'reflect-metadata';
import { AppDataSource } from './typeorm.config';
import { CategoryEntity } from '../modules/categories/category.entity';
import { CategoryTranslationEntity } from '../modules/categories/category-translation.entity';
import { ProductEntity } from '../modules/products/product.entity';
import { ProductTranslationEntity } from '../modules/products/product-translation.entity';

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

const CATEGORY_TRANSLATIONS: Record<
  string,
  Record<string, { name: string; description: string }>
> = {
  apparel: {
    km: {
      name: 'សម្លៀកបំពាក់',
      description: 'អាវយឺត អាវរងា និងមួកទាន់សម័យ',
    },
  },
  drinkware: {
    km: {
      name: 'ប្រដាប់ទទួលទានទឹក',
      description: 'កែវសេរ៉ាមិច និងដបទឹកគុណភាពខ្ពស់',
    },
  },
  accessories: {
    km: {
      name: 'គ្រឿងបន្ទាប់បន្សំ',
      description: 'កាបូប ស្ទីគ័រ និងខ្សែសាកឧបករណ៍',
    },
  },
};

/**
 * `weightGrams` arrived in M10 — shipping rates by weight, and nothing in this
 * project knew what anything weighed. The figures are realistic rather than
 * round, and the sizes genuinely differ where the garment does, so a basket's
 * weight is not a multiple of one number and the band boundary at 1000g gets
 * crossed by plausible baskets rather than only by contrived ones.
 */
const PRODUCTS = [
  {
    sku: 'TSH-BLK-S',
    slug: 'black-tee-small',
    name: 'Black Tee (S)',
    priceMinor: 1999,
    weightGrams: 165,
    category: 'apparel',
    description: 'Combed cotton, regular fit.',
  },
  {
    sku: 'TSH-BLK-M',
    slug: 'black-tee-medium',
    name: 'Black Tee (M)',
    priceMinor: 1999,
    weightGrams: 180,
    category: 'apparel',
    description: 'Combed cotton, regular fit.',
  },
  {
    sku: 'TSH-BLK-L',
    slug: 'black-tee-large',
    name: 'Black Tee (L)',
    priceMinor: 1999,
    weightGrams: 195,
    category: 'apparel',
    description: 'Combed cotton, regular fit.',
  },
  {
    sku: 'HOD-GRY-M',
    slug: 'grey-hoodie-medium',
    name: 'Grey Hoodie (M)',
    priceMinor: 4950,
    weightGrams: 620,
    category: 'apparel',
    description: 'Brushed fleece lining.',
  },
  {
    sku: 'HOD-GRY-L',
    slug: 'grey-hoodie-large',
    name: 'Grey Hoodie (L)',
    priceMinor: 4950,
    weightGrams: 660,
    category: 'apparel',
    description: 'Brushed fleece lining.',
  },
  {
    sku: 'CAP-NVY-1',
    slug: 'navy-cap',
    name: 'Navy Cap',
    priceMinor: 2250,
    weightGrams: 95,
    category: 'apparel',
    description: 'Six-panel, adjustable strap.',
  },
  {
    sku: 'MUG-WHT-1',
    slug: 'white-mug',
    name: 'White Mug',
    priceMinor: 1250,
    weightGrams: 400,
    category: 'drinkware',
    description: '325ml ceramic, dishwasher safe.',
  },
  {
    sku: 'MUG-BLK-1',
    slug: 'black-mug',
    name: 'Black Mug',
    priceMinor: 1250,
    weightGrams: 400,
    category: 'drinkware',
    description: '325ml ceramic, dishwasher safe.',
  },
  {
    sku: 'BTL-STL-1',
    slug: 'steel-bottle',
    name: 'Steel Bottle',
    priceMinor: 3400,
    weightGrams: 340,
    category: 'drinkware',
    description: '750ml vacuum insulated.',
  },
  {
    sku: 'BAG-CVS-1',
    slug: 'canvas-tote',
    name: 'Canvas Tote',
    priceMinor: 1800,
    weightGrams: 220,
    category: 'accessories',
    description: 'Heavy cotton canvas.',
  },
  {
    sku: 'STK-PCK-1',
    slug: 'sticker-pack',
    name: 'Sticker Pack',
    priceMinor: 600,
    weightGrams: 30,
    category: 'accessories',
    description: 'Ten vinyl stickers.',
  },
  {
    sku: 'CBL-USB-1',
    slug: 'usb-c-cable',
    name: 'USB-C Cable',
    priceMinor: 1400,
    weightGrams: 90,
    category: 'accessories',
    description: 'Braided, 2 metres, 100W.',
  },
];

const PRODUCT_TRANSLATIONS: Record<
  string,
  Record<string, { name: string; description: string }>
> = {
  'TSH-BLK-S': {
    km: {
      name: 'អាវយឺតពណ៌ខ្មៅ (S)',
      description: 'កប្បាសសុទ្ធ រាងសមល្មម ងាយស្រួលពាក់។',
    },
  },
  'TSH-BLK-M': {
    km: {
      name: 'អាវយឺតពណ៌ខ្មៅ (M)',
      description: 'កប្បាសសុទ្ធ រាងសមល្មម ងាយស្រួលពាក់។',
    },
  },
  'TSH-BLK-L': {
    km: {
      name: 'អាវយឺតពណ៌ខ្មៅ (L)',
      description: 'កប្បាសសុទ្ធ រាងសមល្មម ងាយស្រួលពាក់។',
    },
  },
  'HOD-GRY-M': {
    km: {
      name: 'អាវរងាមានមួកពណ៌ប្រផេះ (M)',
      description: 'ស្រទាប់ខាងក្នុងរោមទន់កក់ក្តៅ ការពាររងាបានយ៉ាងល្អ។',
    },
  },
  'HOD-GRY-L': {
    km: {
      name: 'អាវរងាមានមួកពណ៌ប្រផេះ (L)',
      description: 'ស្រទាប់ខាងក្នុងរោមទន់កក់ក្តៅ ការពាររងាបានយ៉ាងល្អ។',
    },
  },
  'CAP-NVY-1': {
    km: {
      name: 'មួកពណ៌ខៀវចាស់',
      description: 'មួក៦ផ្ទាំង ខ្សែរឹតអាចសារ៉េតាមទំហំក្បាលបាន។',
    },
  },
  'MUG-WHT-1': {
    km: {
      name: 'កែវសេរ៉ាមិចពណ៌ស',
      description: 'សេរ៉ាមិចចំណុះ ៣២៥ មីលីលីត្រ ធន់នឹងកម្តៅ និងសុវត្ថិភាពសម្រាប់ម៉ាស៊ីនលាងចាន។',
    },
  },
  'MUG-BLK-1': {
    km: {
      name: 'កែវសេរ៉ាមិចពណ៌ខ្មៅ',
      description: 'សេរ៉ាមិចចំណុះ ៣២៥ មីលីលីត្រ ធន់នឹងកម្តៅ និងសុវត្ថិភាពសម្រាប់ម៉ាស៊ីនលាងចាន។',
    },
  },
  'BTL-STL-1': {
    km: {
      name: 'ដបទឹកដែកអ៊ីណុក',
      description: 'ចំណុះ ៧៥០ មីលីលីត្រ រក្សាសីតុណ្ហភាពក្តៅត្រជាក់បានយូរ។',
    },
  },
  'BAG-CVS-1': {
    km: {
      name: 'កាបូបយួរក្រណាត់',
      description: 'ក្រណាត់កប្បាសក្រាស់ជាប់ធន់ មាំល្អ និងប្រើប្រាស់បានយូរ។',
    },
  },
  'STK-PCK-1': {
    km: {
      name: 'កញ្ចប់ស្ទីគ័រ',
      description: 'ស្ទីគ័រវីនីលគុណភាពខ្ពស់ចំនួន ១០ សន្លឹក មិនងាយរលុបពណ៌។',
    },
  },
  'CBL-USB-1': {
    km: {
      name: 'ខ្សែសាក USB-C',
      description: 'ខ្សែក្រងប្រវែង ២ ម៉ែត្រ កម្លាំង ១០០ វ៉ាត់ សាកថ្មលឿន។',
    },
  },
};

async function seed(): Promise<void> {
  await AppDataSource.initialize();
  console.log('Connected. Seeding catalog...');

  const categories = AppDataSource.getRepository(CategoryEntity);
  const categoryTranslationsRepo = AppDataSource.getRepository(CategoryTranslationEntity);
  const products = AppDataSource.getRepository(ProductEntity);
  const productTranslationsRepo = AppDataSource.getRepository(ProductTranslationEntity);

  const idBySlug = new Map<string, string>();

  for (const input of CATEGORIES) {
    const existing = await categories.findOne({ where: { slug: input.slug } });
    const saved = await categories.save(
      existing ? Object.assign(existing, input) : categories.create(input),
    );
    idBySlug.set(saved.slug, saved.id);
  }
  console.log(`  ${CATEGORIES.length} categories`);

  // Seed category translations
  let catTransCount = 0;
  for (const [slug, locales] of Object.entries(CATEGORY_TRANSLATIONS)) {
    const categoryId = idBySlug.get(slug);
    if (!categoryId) continue;
    for (const [locale, t] of Object.entries(locales)) {
      const existing = await categoryTranslationsRepo.findOne({
        where: { categoryId, locale },
      });
      await categoryTranslationsRepo.save(
        existing
          ? Object.assign(existing, t)
          : categoryTranslationsRepo.create({ categoryId, locale, ...t }),
      );
      catTransCount++;
    }
  }
  console.log(`  ${catTransCount} category translations`);

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

  // Seed product translations
  let prodTransCount = 0;
  for (const p of await products.find()) {
    const locales = PRODUCT_TRANSLATIONS[p.sku];
    if (!locales) continue;
    for (const [locale, t] of Object.entries(locales)) {
      const existing = await productTranslationsRepo.findOne({
        where: { productId: p.id, locale },
      });
      await productTranslationsRepo.save(
        existing
          ? Object.assign(existing, t)
          : productTranslationsRepo.create({ productId: p.id, locale, ...t }),
      );
      prodTransCount++;
    }
  }
  console.log(`  ${prodTransCount} product translations`);

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
