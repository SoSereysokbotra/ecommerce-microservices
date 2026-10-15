import { Body, Controller, Get, Headers, Param, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, Public, Roles } from '@libs/common';
import { UserRole } from '@libs/shared-types';
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

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({
    summary:
      'Rename a category or change its description (Admin/Staff only); the slug is immutable',
  })
  @ApiOkResponse({ type: CategoryResponseDto })
  update(
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CategoryEntity> {
    return this.categories.update(id, body, correlationId);
  }
}
