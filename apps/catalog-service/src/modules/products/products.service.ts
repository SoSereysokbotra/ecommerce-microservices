import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ProductEntity } from './product.entity';
import { CategoryEntity } from '../categories/category.entity';
import { CreateProductDto, ListProductsQueryDto, UpdateProductDto } from './dto/product.dto';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Keyset cursor: `createdAt|id`, base64url encoded so callers treat it as opaque. */
interface Cursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly products: Repository<ProductEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categories: Repository<CategoryEntity>,
  ) {}

  async list(query: ListProductsQueryDto): Promise<{
    data: ProductEntity[];
    nextCursor: string | null;
  }> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const qb = this.products.createQueryBuilder('p');

    if (query.active !== false) {
      qb.andWhere('p.active = :active', { active: true });
    }

    if (query.category) {
      const categoryId = await this.resolveCategoryId(query.category);
      // An unknown category yields an empty page rather than a 404: the caller
      // asked to filter, not to fetch that category.
      if (!categoryId) {
        return { data: [], nextCursor: null };
      }
      qb.andWhere('p.categoryId = :categoryId', { categoryId });
    }

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      // Keyset pagination, not OFFSET: stable when rows are inserted mid-scan,
      // and it does not get slower as the offset grows.
      qb.andWhere('(p.createdAt, p.id) < (:createdAt, :id)', {
        createdAt: cursor.createdAt,
        id: cursor.id,
      });
    }

    // Fetch one extra row to learn whether another page exists.
    const rows = await qb
      .orderBy('p.createdAt', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .take(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];

    return {
      data,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async findOne(idOrSlug: string): Promise<ProductEntity> {
    const product = await this.products.findOne({
      where: isUuid(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug },
    });

    if (!product) {
      throw new NotFoundException(`Product '${idOrSlug}' not found`);
    }

    return product;
  }

  async create(input: CreateProductDto): Promise<ProductEntity> {
    await this.assertCategoryExists(input.categoryId);

    try {
      return await this.products.save(
        this.products.create({ ...input, currency: input.currency.toUpperCase() }),
      );
    } catch (error) {
      throw this.translateUniqueViolation(error, input.sku, input.slug);
    }
  }

  async update(id: string, input: UpdateProductDto): Promise<ProductEntity> {
    const product = await this.findOne(id);
    await this.assertCategoryExists(input.categoryId);

    Object.assign(product, input);
    if (input.currency) {
      product.currency = input.currency.toUpperCase();
    }

    try {
      return await this.products.save(product);
    } catch (error) {
      throw this.translateUniqueViolation(error, product.sku, product.slug);
    }
  }

  private async resolveCategoryId(categoryOrSlug: string): Promise<string | null> {
    if (isUuid(categoryOrSlug)) {
      return categoryOrSlug;
    }
    const category = await this.categories.findOne({ where: { slug: categoryOrSlug } });
    return category?.id ?? null;
  }

  private async assertCategoryExists(categoryId?: string | null): Promise<void> {
    if (!categoryId) {
      return;
    }
    const exists = await this.categories.exists({ where: { id: categoryId } });
    if (!exists) {
      throw new NotFoundException(`Category '${categoryId}' not found`);
    }
  }

  /** Turns Postgres 23505 into a message naming the field that actually clashed. */
  private translateUniqueViolation(error: unknown, sku: string, slug: string): unknown {
    if (error instanceof QueryFailedError && (error as { code?: string }).code === '23505') {
      const detail = (error as unknown as { detail?: string }).detail ?? '';
      const field = detail.includes('slug') ? `slug '${slug}'` : `sku '${sku}'`;
      return new ConflictException(`A product with ${field} already exists`);
    }
    return error;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`).toString('base64url');
}

function decodeCursor(raw?: string): Cursor | null {
  if (!raw) {
    return null;
  }

  try {
    const [createdAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
      return null;
    }
    return { createdAt, id };
  } catch {
    // A malformed cursor returns the first page instead of a 500.
    return null;
  }
}
