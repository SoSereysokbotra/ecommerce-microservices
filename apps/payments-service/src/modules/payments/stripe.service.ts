import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * Thin wrapper over the Stripe SDK.
 *
 * Everything that talks to Stripe goes through here so the idempotency-key
 * discipline lives in one place, and so tests can substitute it.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('stripeSecretKey');
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }

    if (secretKey.startsWith('sk_live_')) {
      // Refuse a live key by accident. Going live is a deliberate decision that
      // needs a business entity, a refund policy and real support — see §3 of
      // docs/PROJECT_PLAN.md — not a stray environment variable.
      throw new Error(
        'A live Stripe key was supplied. This project runs in test mode; ' +
          'set STRIPE_ALLOW_LIVE=true only after the go-live checklist is done.',
      );
    }

    this.stripe = new Stripe(secretKey);
    this.webhookSecret = config.get<string>('stripeWebhookSecret') ?? '';
  }

  /**
   * Create (or return) the PaymentIntent for an order.
   *
   * `idempotencyKey` is what makes this safe to call repeatedly: Stripe returns
   * the original intent for a repeated key rather than creating a second one,
   * so a redelivered `payment.requested` event cannot produce two charges.
   */
  async createPaymentIntent(input: {
    amountMinor: number;
    currency: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        metadata: { orderId: input.orderId },
        // Card only, and no redirect-based methods: this project has no
        // return_url flow, and offering a method we cannot complete would
        // strand the customer.
        payment_method_types: ['card'],
      },
      { idempotencyKey: input.idempotencyKey },
    );
  }

  async refund(input: {
    paymentIntentId: string;
    amountMinor: number;
    idempotencyKey: string;
    reason?: string;
  }): Promise<Stripe.Refund> {
    return this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountMinor,
        metadata: input.reason ? { reason: input.reason } : undefined,
      },
      { idempotencyKey: input.idempotencyKey },
    );
  }

  /**
   * Verify a webhook came from Stripe and not from someone who guessed the URL.
   *
   * Requires the EXACT bytes Stripe sent. Any JSON parse-and-restringify
   * changes the payload and the signature stops matching, which is why the
   * webhook route is excluded from the global body parser.
   */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  /** Test-mode only: confirm an intent server-side so a webhook fires. */
  async confirmForTest(
    paymentIntentId: string,
    paymentMethod: string,
  ): Promise<Stripe.PaymentIntent> {
    this.logger.warn(`Confirming ${paymentIntentId} with ${paymentMethod} (test helper)`);
    return this.stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethod,
    });
  }
}
