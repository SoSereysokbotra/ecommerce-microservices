import { Body, Controller, Get, Headers, Param, Patch, Query } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
  @ApiQuery({
    name: 'locale',
    required: false,
    description: 'Requested locale (e.g. "km" or "en"). Falls back to English if missing.',
  })
  @ApiHeader({
    name: 'x-locale',
    required: false,
    description: 'Requested locale header (e.g. "km" or "en").',
  })
  @ApiOkResponse({ type: [CategoryResponseDto] })
  list(
    @Query('locale') queryLocale?: string,
    @Headers('x-locale') headerLocale?: string,
  ): Promise<CategoryEntity[]> {
    return this.categories.list(queryLocale || headerLocale);
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
