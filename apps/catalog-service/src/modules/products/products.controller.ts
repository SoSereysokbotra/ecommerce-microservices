import { Headers, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CORRELATION_ID_HEADER, Public, Roles } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import {
  CreateProductDto,
  ListProductsQueryDto,
  PaginatedProductsDto,
  ProductResponseDto,
  UpdateProductDto,
} from './dto/product.dto';

@ApiTags('catalog')
@Controller('catalog/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /** Browsing the catalog does not require an account. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'List products' })
  @ApiOkResponse({ type: PaginatedProductsDto })
  list(
    @Query() query: ListProductsQueryDto,
    @Headers('x-locale') headerLocale?: string,
  ): Promise<PaginatedProductsDto> {
    return this.products.list(query, headerLocale);
  }

  @Public()
  @Get(':idOrSlug')
  @ApiOperation({ summary: 'Get one product by id or slug' })
  @ApiOkResponse({ type: ProductResponseDto })
  findOne(
    @Param('idOrSlug') idOrSlug: string,
    @Query('locale') queryLocale?: string,
    @Headers('x-locale') headerLocale?: string,
  ): Promise<ProductResponseDto> {
    return this.products.findOne(idOrSlug, queryLocale || headerLocale);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Create a product (Admin/Staff only)' })
  @ApiOkResponse({ type: ProductResponseDto })
  create(
    @Body() body: CreateProductDto,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<ProductResponseDto> {
    return this.products.create(body, correlationId);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Update a product (Admin/Staff only)' })
  @ApiOkResponse({ type: ProductResponseDto })
  update(
    @Param('id') id: string,
    @Body() body: UpdateProductDto,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<ProductResponseDto> {
    return this.products.update(id, body, correlationId);
  }
}
