import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { ChargeDto, ChargeResultDto } from './dto/charge.dto';

/**
 * Throwaway payment stub for M2.
 *
 * It holds no state, talks to no provider, and always succeeds unless
 * PAYMENTS_ALWAYS_DECLINE is set. M4 replaces it with a real Stripe-backed
 * service that persists payments, verifies webhook signatures, and refunds.
 *
 * Its only job here is to be something the orders service calls synchronously —
 * and something that can be stopped mid-checkout to expose what that costs.
 */
@ApiTags('payments')
@Controller('payments')
export class ChargesController {
  @Post('charge')
  @ApiOperation({ summary: 'Charge an order (stub — always succeeds unless forced to decline)' })
  @ApiOkResponse({ type: ChargeResultDto })
  charge(@Body() body: ChargeDto): ChargeResultDto {
    const decline = process.env.PAYMENTS_ALWAYS_DECLINE === 'true';

    return {
      status: decline ? 'DECLINED' : 'AUTHORIZED',
      orderId: body.orderId,
      amountMinor: body.amountMinor,
      currency: body.currency.toUpperCase(),
      reference: `stub_${randomUUID()}`,
    };
  }

  @Get('mode')
  @ApiOperation({ summary: 'Report whether the stub is forcing declines' })
  mode(): { alwaysDecline: boolean } {
    return { alwaysDecline: process.env.PAYMENTS_ALWAYS_DECLINE === 'true' };
  }
}
