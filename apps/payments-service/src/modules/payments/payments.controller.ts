import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';
import { PaymentResponseDto, RefundRequestDto } from './dto/payment.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly stripe: StripeService,
  ) {}

  /**
   * The client secret the storefront needs to complete payment.
   *
   * Not sensitive on its own — it only works alongside the publishable key, and
   * only for this one intent.
   */
  @Get('by-order/:orderId')
  @ApiOperation({ summary: 'Get the payment for an order' })
  @ApiOkResponse({ type: PaymentResponseDto })
  async byOrder(@Param('orderId', ParseUUIDPipe) orderId: string): Promise<PaymentResponseDto> {
    return this.payments.findByOrderOrFail(orderId);
  }

  /**
   * Stripe's webhook endpoint.
   *
   * Public because Stripe cannot present our JWT. It is authenticated instead
   * by the signature over the raw request body, which is strictly stronger:
   * a bearer token could leak, whereas a valid signature proves Stripe sent
   * these exact bytes.
   */
  @Public()
  @Post('webhook')
  @ApiExcludeEndpoint()
  async webhook(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    // rawBody is captured by the express.raw() handler registered for this
    // route in main.ts. Parsing and re-serialising the JSON would change the
    // bytes and the signature would no longer verify.
    if (!request.rawBody) {
      throw new BadRequestException('Raw body unavailable; webhook parser is misconfigured');
    }

    let event;
    try {
      event = this.stripe.constructEvent(request.rawBody, signature);
    } catch (error) {
      // A bad signature is a rejected request, not a server error. Stripe will
      // not retry a 400, which is right: the payload was never ours.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Rejected webhook with invalid signature: ${message}`);
      throw new BadRequestException(`Signature verification failed: ${message}`);
    }

    const applied = await this.payments.applyWebhook(event);

    // 200 either way. Telling Stripe a duplicate failed would make it retry
    // forever; the duplicate was handled correctly by doing nothing.
    return { received: true, duplicate: !applied };
  }

  @Post('refund')
  @ApiOperation({ summary: 'Refund an order (idempotent)' })
  async refund(@Body() body: RefundRequestDto) {
    return this.payments.refund(body.orderId, body.reason);
  }
}
