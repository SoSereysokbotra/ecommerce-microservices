import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
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
  list(@Query() query: ListProductsQueryDto): Promise<PaginatedProductsDto> {
    return this.products.list(query);
  }

  @Public()
  @Get(':idOrSlug')
  @ApiOperation({ summary: 'Get one product by id or slug' })
  @ApiOkResponse({ type: ProductResponseDto })
  findOne(@Param('idOrSlug') idOrSlug: string): Promise<ProductResponseDto> {
    return this.products.findOne(idOrSlug);
  }

  // Staff-only in M16, when real authorisation lands. Until then the gateway's
  // JWT check is the only gate.
  @Post()
  @ApiOperation({ summary: 'Create a product' })
  @ApiOkResponse({ type: ProductResponseDto })
  create(@Body() body: CreateProductDto): Promise<ProductResponseDto> {
    return this.products.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a product' })
  @ApiOkResponse({ type: ProductResponseDto })
  update(@Param('id') id: string, @Body() body: UpdateProductDto): Promise<ProductResponseDto> {
    return this.products.update(id, body);
  }
}
