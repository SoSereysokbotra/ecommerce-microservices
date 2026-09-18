import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { announceCategory } from '../../events/product-events';
import { CategoryEntity } from './category.entity';
import { UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categories: Repository<CategoryEntity>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  list(): Promise<CategoryEntity[]> {
    return this.categories.find({ order: { name: 'ASC' } });
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
