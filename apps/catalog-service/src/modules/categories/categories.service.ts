import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { announceCategory } from '../../events/product-events';
import { CategoryEntity } from './category.entity';
import { CategoryTranslationEntity } from './category-translation.entity';
import { UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categories: Repository<CategoryEntity>,
    @InjectRepository(CategoryTranslationEntity)
    private readonly categoryTranslations: Repository<CategoryTranslationEntity>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  async list(locale?: string): Promise<CategoryEntity[]> {
    const categories = await this.categories.find({ order: { name: 'ASC' } });
    const normLocale = locale?.toLowerCase();
    if (normLocale && normLocale !== 'en' && categories.length > 0) {
      const translations = await this.categoryTranslations.find({
        where: { categoryId: In(categories.map((c) => c.id)), locale: normLocale },
      });
      const transMap = new Map(translations.map((t) => [t.categoryId, t]));
      return categories.map((c) => {
        const t = transMap.get(c.id);
        return t
          ? ({
              ...c,
              name: t.name || c.name,
              description: t.description ?? c.description,
            } as CategoryEntity)
          : c;
      });
    }
    return categories;
  }

  /**
   * The first category write API — M12 step 6, because a category rename is
   * the projection's fan-out case and it needed a trigger.
   *
   * Same shape as `ProductsService.update()`: one conditional UPDATE with the
   * version in the WHERE, because `@VersionColumn` does not check on save
   * (HANDOFF §5); the row and its `category.updated` commit together.
   * The slug is not updatable — see `UpdateCategoryDto`.
   */
  async update(
    id: string,
    input: UpdateCategoryDto,
    correlationId?: string,
  ): Promise<CategoryEntity> {
    const category = await this.categories.findOneBy({ id });
    if (!category) {
      throw new NotFoundException(`Category ${id} not found`);
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(CategoryEntity)
        .set({
          name: input.name ?? category.name,
          description: input.description === undefined ? category.description : input.description,
          version: () => '"version" + 1',
        })
        .where('id = :id AND version = :version', { id, version: category.version })
        .execute();

      if (result.affected === 0) {
        throw new ConflictException(
          `Category '${category.slug}' was changed by someone else while you were editing it. ` +
            `Reload and try again.`,
        );
      }

      const saved = await manager.findOneByOrFail(CategoryEntity, { id });
      await announceCategory(this.outbox, manager, 'updated', saved, correlationId);
      return saved;
    });
  }
}
