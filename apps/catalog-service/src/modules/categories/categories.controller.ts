import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { CategoriesService } from './categories.service';
import { CategoryEntity } from './category.entity';

@ApiTags('catalog')
@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List categories' })
  list(): Promise<CategoryEntity[]> {
    return this.categories.list();
  }
}
