import { In, Repository, DataSource } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { ProductsService } from '../src/modules/products/products.service';
import { ProductEntity } from '../src/modules/products/product.entity';
import { CategoryEntity } from '../src/modules/categories/category.entity';

describe('ProductsService - list with ids filter', () => {
  let service: ProductsService;
  let productsRepo: jest.Mocked<Repository<ProductEntity>>;
  let categoriesRepo: jest.Mocked<Repository<CategoryEntity>>;
  let dataSource: jest.Mocked<DataSource>;
  let outbox: jest.Mocked<OutboxService>;

  beforeEach(() => {
    productsRepo = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<ProductEntity>>;

    categoriesRepo = {} as unknown as jest.Mocked<Repository<CategoryEntity>>;
    dataSource = {} as unknown as jest.Mocked<DataSource>;
    outbox = {} as unknown as jest.Mocked<OutboxService>;

    service = new ProductsService(productsRepo, categoriesRepo, dataSource, outbox);
  });

  it('filters by product ids when ids query param is provided', async () => {
    const p1 = { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', name: 'Product 1' } as ProductEntity;
    const p2 = { id: 'c3d4e5f6-a7b8-1234-5678-9abcdef01234', name: 'Product 2' } as ProductEntity;
    productsRepo.find.mockResolvedValue([p1, p2]);

    const result = await service.list({
      ids: '3fa85f64-5717-4562-b3fc-2c963f66afa6,c3d4e5f6-a7b8-1234-5678-9abcdef01234',
    });

    expect(productsRepo.find).toHaveBeenCalledWith({
      where: {
        id: In(['3fa85f64-5717-4562-b3fc-2c963f66afa6', 'c3d4e5f6-a7b8-1234-5678-9abcdef01234']),
      },
    });
    expect(result).toEqual({
      data: [p1, p2],
      nextCursor: null,
    });
    expect(productsRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns empty array when ids string has no non-empty ids', async () => {
    const result = await service.list({ ids: ' , ' });
    expect(result).toEqual({ data: [], nextCursor: null });
    expect(productsRepo.find).not.toHaveBeenCalled();
  });
});
