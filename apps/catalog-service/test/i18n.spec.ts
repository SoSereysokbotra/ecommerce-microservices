import { In, Repository, DataSource } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { ProductsService } from '../src/modules/products/products.service';
import { ProductEntity } from '../src/modules/products/product.entity';
import { ProductTranslationEntity } from '../src/modules/products/product-translation.entity';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { CategoryEntity } from '../src/modules/categories/category.entity';
import { CategoryTranslationEntity } from '../src/modules/categories/category-translation.entity';

describe('Catalog i18n & Translation Fallbacks (M20)', () => {
  describe('ProductsService - i18n', () => {
    let service: ProductsService;
    let productsRepo: jest.Mocked<Repository<ProductEntity>>;
    let categoriesRepo: jest.Mocked<Repository<CategoryEntity>>;
    let productTranslationsRepo: jest.Mocked<Repository<ProductTranslationEntity>>;
    let dataSource: jest.Mocked<DataSource>;
    let outbox: jest.Mocked<OutboxService>;

    beforeEach(() => {
      productsRepo = {
        findOne: jest.fn(),
        find: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as unknown as jest.Mocked<Repository<ProductEntity>>;

      categoriesRepo = {} as unknown as jest.Mocked<Repository<CategoryEntity>>;
      productTranslationsRepo = {
        findOne: jest.fn(),
        find: jest.fn(),
      } as unknown as jest.Mocked<Repository<ProductTranslationEntity>>;
      dataSource = {} as unknown as jest.Mocked<DataSource>;
      outbox = {} as unknown as jest.Mocked<OutboxService>;

      service = new ProductsService(
        productsRepo,
        categoriesRepo,
        productTranslationsRepo,
        dataSource,
        outbox,
      );
    });

    it('returns Khmer translation when available for findOne', async () => {
      const baseProduct = {
        id: 'p-1',
        slug: 'black-tee-small',
        name: 'Black Tee (S)',
        description: 'Combed cotton, regular fit.',
        priceMinor: 1999,
        currency: 'USD',
      } as ProductEntity;

      productsRepo.findOne.mockResolvedValue(baseProduct);
      productTranslationsRepo.findOne.mockResolvedValue({
        id: 'pt-1',
        productId: 'p-1',
        locale: 'km',
        name: 'អាវយឺតពណ៌ខ្មៅ (S)',
        description: 'កប្បាសសុទ្ធ រាងសមល្មម ងាយស្រួលពាក់។',
      } as ProductTranslationEntity);

      const result = await service.findOne('black-tee-small', 'km');

      expect(productsRepo.findOne).toHaveBeenCalledWith({
        where: { slug: 'black-tee-small' },
      });
      expect(productTranslationsRepo.findOne).toHaveBeenCalledWith({
        where: { productId: 'p-1', locale: 'km' },
      });
      expect(result.name).toBe('អាវយឺតពណ៌ខ្មៅ (S)');
      expect(result.description).toBe('កប្បាសសុទ្ធ រាងសមល្មម ងាយស្រួលពាក់។');
      expect(result.priceMinor).toBe(1999);
    });

    it('falls back to base English name and description when Khmer translation is absent', async () => {
      const baseProduct = {
        id: 'p-2',
        slug: 'special-item',
        name: 'Special Item',
        description: 'English description.',
        priceMinor: 2500,
        currency: 'USD',
      } as ProductEntity;

      productsRepo.findOne.mockResolvedValue(baseProduct);
      productTranslationsRepo.findOne.mockResolvedValue(null);

      const result = await service.findOne('special-item', 'km');

      expect(result.name).toBe('Special Item');
      expect(result.description).toBe('English description.');
    });

    it('does not query translation table if locale is English or omitted', async () => {
      const baseProduct = {
        id: 'p-3',
        slug: 'navy-cap',
        name: 'Navy Cap',
        description: 'Six-panel, adjustable strap.',
      } as ProductEntity;

      productsRepo.findOne.mockResolvedValue(baseProduct);

      const resultEn = await service.findOne('navy-cap', 'en');
      const resultNone = await service.findOne('navy-cap');

      expect(resultEn.name).toBe('Navy Cap');
      expect(resultNone.name).toBe('Navy Cap');
      expect(productTranslationsRepo.findOne).not.toHaveBeenCalled();
    });

    it('merges translations in list query with ids', async () => {
      const p1 = {
        id: 'p-1',
        name: 'Black Tee (S)',
        description: 'English description 1',
      } as ProductEntity;
      const p2 = {
        id: 'p-2',
        name: 'Steel Bottle',
        description: 'English description 2',
      } as ProductEntity;

      productsRepo.find.mockResolvedValue([p1, p2]);
      productTranslationsRepo.find.mockResolvedValue([
        {
          id: 'pt-1',
          productId: 'p-1',
          locale: 'km',
          name: 'អាវយឺតពណ៌ខ្មៅ (S)',
          description: 'ការពិពណ៌នាជាភាសាខ្មែរ',
        } as ProductTranslationEntity,
      ]);

      const result = await service.list({ ids: 'p-1,p-2', locale: 'km' });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].name).toBe('អាវយឺតពណ៌ខ្មៅ (S)');
      expect(result.data[0].description).toBe('ការពិពណ៌នាជាភាសាខ្មែរ');
      // p2 had no translation, so falls back to English
      expect(result.data[1].name).toBe('Steel Bottle');
      expect(result.data[1].description).toBe('English description 2');
    });
  });

  describe('CategoriesService - i18n', () => {
    let categoriesService: CategoriesService;
    let categoriesRepo: jest.Mocked<Repository<CategoryEntity>>;
    let categoryTranslationsRepo: jest.Mocked<Repository<CategoryTranslationEntity>>;
    let dataSource: jest.Mocked<DataSource>;
    let outbox: jest.Mocked<OutboxService>;

    beforeEach(() => {
      categoriesRepo = {
        find: jest.fn(),
      } as unknown as jest.Mocked<Repository<CategoryEntity>>;
      categoryTranslationsRepo = {
        find: jest.fn(),
      } as unknown as jest.Mocked<Repository<CategoryTranslationEntity>>;
      dataSource = {} as unknown as jest.Mocked<DataSource>;
      outbox = {} as unknown as jest.Mocked<OutboxService>;

      categoriesService = new CategoriesService(
        categoriesRepo,
        categoryTranslationsRepo,
        dataSource,
        outbox,
      );
    });

    it('returns Khmer category names when locale is km', async () => {
      const c1 = {
        id: 'cat-1',
        slug: 'apparel',
        name: 'Apparel',
        description: 'Shirts and hoodies',
      } as CategoryEntity;
      const c2 = {
        id: 'cat-2',
        slug: 'drinkware',
        name: 'Drinkware',
        description: 'Mugs and bottles',
      } as CategoryEntity;

      categoriesRepo.find.mockResolvedValue([c1, c2]);
      categoryTranslationsRepo.find.mockResolvedValue([
        {
          id: 'ct-1',
          categoryId: 'cat-1',
          locale: 'km',
          name: 'សម្លៀកបំពាក់',
          description: 'អាវយឺត អាវរងា និងមួកទាន់សម័យ',
        } as CategoryTranslationEntity,
      ]);

      const result = await categoriesService.list('km');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('សម្លៀកបំពាក់');
      expect(result[0].description).toBe('អាវយឺត អាវរងា និងមួកទាន់សម័យ');
      // c2 falls back to English
      expect(result[1].name).toBe('Drinkware');
      expect(result[1].description).toBe('Mugs and bottles');
    });

    it('returns base English categories when locale is en or omitted', async () => {
      const c1 = { id: 'cat-1', name: 'Apparel' } as CategoryEntity;
      categoriesRepo.find.mockResolvedValue([c1]);

      const result = await categoriesService.list('en');

      expect(result[0].name).toBe('Apparel');
      expect(categoryTranslationsRepo.find).not.toHaveBeenCalled();
    });
  });
});
