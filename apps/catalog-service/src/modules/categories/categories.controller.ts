import { Body, Controller, Get, Headers, Param, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, Public } from '@libs/common';
import { CategoriesService } from './categories.service';
import { CategoryEntity } from './category.entity';
import { CategoryResponseDto, UpdateCategoryDto } from './dto/category.dto';

@ApiTags('catalog')
@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List categories' })
  @ApiOkResponse({ type: [CategoryResponseDto] })
  list(): Promise<CategoryEntity[]> {
    return this.categories.list();
  }

  // Staff-only in M16. Until then the gateway's JWT check is the only gate —
  // the same debt as creating a product (HANDOFF §9).
  @Patch(':id')
  @ApiOperation({ summary: 'Rename a category or change its description; the slug is immutable' })
  @ApiOkResponse({ type: CategoryResponseDto })
  update(
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CategoryEntity> {
    return this.categories.update(id, body, correlationId);
  }
}
