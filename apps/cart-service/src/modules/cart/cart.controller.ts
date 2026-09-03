import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, USER_ID_HEADER } from '@libs/common';
import { CartIdentity, CartService, CartView } from './cart.service';
import { AddCartItemDto, CartResponseDto, SetCartItemQtyDto } from './dto/cart.dto';

const CART_TOKEN_HEADER = 'x-cart-token';

/**
 * The cart works signed in or not, so nothing here demands a user id.
 *
 * `x-user-id` is set by the gateway from a JWT it has already verified and is
 * stripped from anything a client sends, so it can be trusted. `x-cart-token`
 * comes straight from the client and is treated as untrusted — the store
 * format-checks it before it is ever used to build a Redis key.
 *
 * A header rather than a cookie because the storefront and gateway are on
 * different origins; see docs/M7_CART_PLAN.md §3.
 */
@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current cart (guest or signed in)' })
  @ApiOkResponse({ type: CartResponseDto })
  get(
    @Headers(USER_ID_HEADER) userId?: string,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CartView> {
    return this.carts.getCart(this.identity(userId, cartToken, correlationId));
  }

  @Post('items')
  @ApiOperation({ summary: 'Add a product, accumulating onto any existing line' })
  @ApiOkResponse({ type: CartResponseDto })
  add(
    @Body() body: AddCartItemDto,
    @Headers(USER_ID_HEADER) userId?: string,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CartView> {
    return this.carts.addItem(
      this.identity(userId, cartToken, correlationId),
      body.productId,
      body.qty,
    );
  }

  @Patch('items/:productId')
  @ApiOperation({ summary: 'Set an absolute quantity; zero removes the line' })
  @ApiOkResponse({ type: CartResponseDto })
  setQty(
    @Param('productId') productId: string,
    @Body() body: SetCartItemQtyDto,
    @Headers(USER_ID_HEADER) userId?: string,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CartView> {
    return this.carts.setItemQty(
      this.identity(userId, cartToken, correlationId),
      productId,
      body.qty,
    );
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a line' })
  @ApiOkResponse({ type: CartResponseDto })
  remove(
    @Param('productId') productId: string,
    @Headers(USER_ID_HEADER) userId?: string,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CartView> {
    return this.carts.removeItem(this.identity(userId, cartToken, correlationId), productId);
  }

  @Delete()
  @ApiOperation({ summary: 'Empty the cart' })
  @ApiOkResponse({ type: CartResponseDto })
  clear(
    @Headers(USER_ID_HEADER) userId?: string,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<CartView> {
    return this.carts.clear(this.identity(userId, cartToken, correlationId));
  }

  private identity(userId?: string, guestToken?: string, correlationId?: string): CartIdentity {
    // Empty strings arrive when the gateway forwards a header it did not set.
    return {
      userId: userId || undefined,
      guestToken: guestToken || undefined,
      correlationId: correlationId || undefined,
    };
  }
}
