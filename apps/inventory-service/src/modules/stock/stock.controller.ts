import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, Roles } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { StockService } from './stock.service';
import { AdjustStockDto, ListStockQueryDto, SetStockDto, StockResponseDto } from './dto/stock.dto';

@ApiTags('inventory')
@Controller('inventory/stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  /** Storefront product pages show availability before login. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'List stock, optionally filtered by product ids' })
  @ApiOkResponse({ type: [StockResponseDto] })
  list(@Query() query: ListStockQueryDto): Promise<StockResponseDto[]> {
    return this.stock.list(query.productIds);
  }

  @Public()
  @Get(':productId')
  @ApiOperation({ summary: 'Get stock for one product' })
  @ApiOkResponse({ type: StockResponseDto })
  findOne(@Param('productId', ParseUUIDPipe) productId: string): Promise<StockResponseDto> {
    return this.stock.findOne(productId);
  }

  @Post(':productId/adjust')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Apply a signed change to available quantity (Admin/Staff only)' })
  @ApiOkResponse({ type: StockResponseDto })
  adjust(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: AdjustStockDto,
  ): Promise<StockResponseDto> {
    return this.stock.adjust(productId, body.delta);
  }

  @Put(':productId')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Set available quantity outright (Admin/Staff only)' })
  @ApiOkResponse({ type: StockResponseDto })
  set(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: SetStockDto,
  ): Promise<StockResponseDto> {
    return this.stock.set(productId, body.availableQty);
  }
}
