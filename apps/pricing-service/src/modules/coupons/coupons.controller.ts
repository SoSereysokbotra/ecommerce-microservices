import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { CouponsService, type CouponRejection, type HoldResult } from './coupons.service';
import { HoldCouponDto } from './dto/coupon.dto';

/**
 * Why a code was refused, in words a shopper can act on.
 *
 * Collapsing all of these into "Invalid code" is the behaviour people complain
 * about: "expired" and "you have already used this" call for completely
 * different reactions, and only one of them means try a different code.
 */
const REJECTION_MESSAGES: Record<CouponRejection, string> = {
  not_found: 'We do not recognise that code.',
  inactive: 'That code is no longer available.',
  not_started: 'That code is not active yet.',
  expired: 'That code has expired.',
  exhausted: 'That code has been fully claimed.',
  per_customer_limit: 'You have already used that code.',
  already_redeemed: 'That code is already applied to this order.',
};

@ApiTags('coupons')
@Controller('pricing/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  /**
   * Check a code without spending it.
   *
   * Read-only by design — the storefront calls this as the shopper types, and a
   * lookup that consumed a use would empty a ten-use coupon in a few keystrokes.
   * The answer can be stale by the time an order is placed; `hold` is the
   * authority and re-checks atomically.
   */
  @Public()
  @Get(':code')
  @ApiOperation({ summary: 'Validate a coupon code without redeeming it' })
  async validate(@Param('code') code: string): Promise<{
    code: string;
    valid: boolean;
    reason?: CouponRejection;
    message?: string;
    discountName?: string;
  }> {
    const resolved = await this.coupons.resolve(code);

    if (!resolved.ok) {
      return {
        code: code.trim().toUpperCase(),
        valid: false,
        reason: resolved.reason,
        message: REJECTION_MESSAGES[resolved.reason],
      };
    }

    return {
      code: resolved.coupon.code,
      valid: true,
      discountName: resolved.discount.name,
    };
  }

  /**
   * Claim one use for an order. Called by orders-service, never by a browser.
   *
   * This is the only endpoint in the service that writes, and the only place a
   * coupon's counter moves. Everything else — quoting, validating — is free and
   * repeatable precisely so that this stays the single point of truth.
   */
  @Public()
  @Post('hold')
  @ApiOperation({ summary: 'Claim one use of a coupon for an order' })
  @ApiOkResponse({ description: 'Whether the use was granted, and why not if it was refused.' })
  hold(@Body() body: HoldCouponDto): Promise<HoldResult> {
    return this.coupons.hold({
      code: body.code,
      orderId: body.orderId,
      customerId: body.customerId,
      amountMinor: body.amountMinor,
    });
  }

  /**
   * Give a claimed use back for an order that never got written.
   *
   * The normal release path is the `order.cancelled` event, which needs an
   * order to exist. This covers only the gap where orders held a use and then
   * failed to insert the row. Idempotent: it acts on a HELD redemption, so
   * calling it twice returns the use once.
   */
  @Public()
  @Post('release')
  @ApiOperation({ summary: 'Release a held coupon use for an order that was never created' })
  async release(@Body() body: { orderId: string }): Promise<{ released: boolean }> {
    return { released: await this.coupons.release(body.orderId) };
  }
}
