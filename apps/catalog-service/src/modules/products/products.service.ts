import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { announceProduct } from '../../events/product-events';
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
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
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

  /**
   * Since M12 every write announces itself, in the **same transaction**.
   *
   * The product row and its `product.created` commit together or not at all.
   * That is the outbox pattern every other service has used since M3, arriving
   * here last because catalog had no consumer until the search index.
   */
  async create(input: CreateProductDto, correlationId?: string): Promise<ProductEntity> {
    await this.assertCategoryExists(input.categoryId);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ProductEntity);
        const product = await repo.save(
          repo.create({ ...input, currency: input.currency.toUpperCase() }),
        );
        const category = await this.categoryFor(manager, product.categoryId);
        await announceProduct(this.outbox, manager, 'created', product, category, correlationId);
        return product;
      });
    } catch (error) {
      throw this.translateWriteFailure(error, input.sku, input.slug);
    }
  }

  async update(
    id: string,
    input: UpdateProductDto,
    correlationId?: string,
  ): Promise<ProductEntity> {
    const product = await this.findOne(id);
    await this.assertCategoryExists(input.categoryId);

    Object.assign(product, input);
    if (input.currency) {
      product.currency = input.currency.toUpperCase();
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        /**
         * One conditional UPDATE, not `save()`.
         *
         * TypeORM's `@VersionColumn` **increments** the version on save but
         * does not **check** it: the SQL it emits is
         * `UPDATE ... SET version = version + 1 WHERE id = $1`, with no
         * `AND version = $2`. Two editors who both read v4 both succeed, and
         * the second silently overwrites the first — the lost update this
         * column was added to prevent. The first version of this method used
         * `save()` and a collision test proved exactly that.
         *
         * So the guard is written here, the way M9 wrote the coupon claim: the
         * condition is evaluated against the committed row inside the
         * statement, and zero rows affected means somebody got there first.
         */
        const result = await manager
          .createQueryBuilder()
          .update(ProductEntity)
          .set({
            name: product.name,
            description: product.description ?? null,
            priceMinor: product.priceMinor,
            currency: product.currency,
            weightGrams: product.weightGrams,
            categoryId: product.categoryId ?? null,
            active: product.active,
            version: () => '"version" + 1',
          })
          .where('id = :id AND version = :version', { id, version: product.version })
          .execute();

        if (result.affected === 0) {
          throw new ConflictException(
            `Product '${product.sku}' was changed by someone else while you were editing it. ` +
              `Reload and try again.`,
          );
        }

        const saved = await manager.findOneByOrFail(ProductEntity, { id });
        const category = await this.categoryFor(manager, saved.categoryId);
        await announceProduct(this.outbox, manager, 'updated', saved, category, correlationId);
        return saved;
      });
    } catch (error) {
      throw this.translateWriteFailure(error, product.sku, product.slug);
    }
  }

  private categoryFor(
    manager: EntityManager,
    categoryId: string | null | undefined,
  ): Promise<CategoryEntity | null> {
    return categoryId
      ? manager.findOneBy(CategoryEntity, { id: categoryId })
      : Promise.resolve(null);
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
  private translateWriteFailure(error: unknown, sku: string, slug: string): unknown {
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
