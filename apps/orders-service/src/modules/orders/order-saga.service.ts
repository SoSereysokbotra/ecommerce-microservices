import { Injectable, Logger } from '@nestjs/common';
import { OutboxService } from '@libs/outbox';
import { DataSource, EntityManager } from 'typeorm';
import { OrderEntity, OrderStatus } from './order.entity';
import { OrderSagaEntity, SagaOutcome, SagaStep } from './order-saga.entity';

/**
 * The checkout saga orchestrator.
 *
 * Forward path
 *   AWAITING_RESERVATION -> AWAITING_PAYMENT -> AWAITING_COMMIT -> done (confirmed)
 *
 * Compensation
 *   reservation failed        -> cancel, nothing to undo
 *   payment declined          -> AWAITING_RELEASE -> cancel
 *   failure after payment     -> AWAITING_REFUND -> AWAITING_RELEASE -> cancel
 *
 * Every transition writes the saga row, the order row, and the next command to
 * the outbox in ONE transaction. That is what makes the saga recoverable: there
 * is no moment where the state says one thing and the queued work says another.
 *
 * Every handler also re-reads the saga and returns early if the step has moved
 * on, so a redelivered reply is a no-op rather than a second transition.
 */
@Injectable()
export class OrderSagaService {
  private readonly logger = new Logger(OrderSagaService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /** Called inside the transaction that creates the order. */
  async start(
    manager: EntityManager,
    orderId: string,
    correlationId?: string,
  ): Promise<OrderSagaEntity> {
    return manager.save(
      manager.create(OrderSagaEntity, {
        orderId,
        currentStep: SagaStep.AWAITING_RESERVATION,
        outcome: SagaOutcome.RUNNING,
        compensating: false,
        correlationId: correlationId ?? null,
      }),
    );
  }

  /** Stock is held. Ask for payment. */
  async onStockReserved(orderId: string, correlationId?: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_RESERVATION, async (manager, order, saga) => {
      order.status = OrderStatus.AWAITING_PAYMENT;
      saga.currentStep = SagaStep.AWAITING_PAYMENT;

      await this.outbox.append(manager, {
        eventType: 'payment.requested',
        aggregateId: orderId,
        correlationId,
        payload: {
          orderId,
          amountMinor: order.totalMinor,
          currency: order.currency,
          customerId: order.customerId,
          /**
           * M11: how to read `amountMinor`.
           *
           * Stripe is handed this number directly, so the charge is right only
           * if our minor-unit convention matches theirs. payments holds
           * Stripe's own list and refuses when the two disagree — two
           * independent sources for one fact, compared before money moves.
           *
           * Null for an order placed before M11, which payments reads as the
           * old assumption of two.
           */
          exponent: order.exponent ?? null,
        },
      });

      this.logger.log(`[saga ${orderId}] reserved -> awaiting payment`);
    });
  }

  /**
   * Could not hold the stock.
   *
   * Nothing was committed anywhere, so there is nothing to undo — the saga ends
   * without compensating. This is the cheapest failure in the system, which is
   * exactly why the reservation is attempted before the payment.
   */
  async onReservationFailed(
    orderId: string,
    reason: string,
    correlationId?: string,
  ): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_RESERVATION, async (manager, order, saga) => {
      order.status = OrderStatus.CANCELLED;
      order.failureReason = reason;
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPENSATED;
      saga.lastError = reason;

      await this.announceCancelled(manager, order, reason, correlationId);

      this.logger.log(`[saga ${orderId}] reservation failed -> cancelled (${reason})`);
    });
  }

  /** Money taken. Turn the hold into a real deduction. */
  async onPaymentAuthorized(orderId: string, correlationId?: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_PAYMENT, async (manager, _o, saga) => {
      saga.currentStep = SagaStep.AWAITING_COMMIT;

      await this.outbox.append(manager, {
        eventType: 'inventory.commit_requested',
        aggregateId: orderId,
        correlationId,
        payload: { orderId },
      });

      this.logger.log(`[saga ${orderId}] paid -> committing stock`);
    });
  }

  /**
   * Card refused. Compensate: give the stock back.
   *
   * This is the transition M2 could not make and ADR-0002 was written about.
   */
  async onPaymentDeclined(orderId: string, reason: string, correlationId?: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_PAYMENT, async (manager, _o, saga) => {
      saga.currentStep = SagaStep.AWAITING_RELEASE;
      saga.compensating = true;
      saga.lastError = reason;

      await this.outbox.append(manager, {
        eventType: 'inventory.release_requested',
        aggregateId: orderId,
        correlationId,
        payload: { orderId, reason },
      });

      this.logger.log(`[saga ${orderId}] declined -> releasing stock (${reason})`);
    });
  }

  /** Stock committed. The order is done. */
  async onInventoryCommitted(orderId: string, correlationId?: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_COMMIT, async (manager, order, saga) => {
      order.status = OrderStatus.CONFIRMED;
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPLETED;

      await this.outbox.append(manager, {
        eventType: 'order.confirmed',
        aggregateId: order.id,
        correlationId: correlationId ?? saga.correlationId ?? undefined,
        /**
         * M10 added the shipping fields, and only because something needs them.
         *
         * The rule this project has used twice already: `order.created` kept a
         * payload of ids and quantities in M8 because its only consumer was
         * inventory, and adding money would have been payload for an imagined
         * future. Here shipping-service consumes this event to create a
         * shipment, and a shipment cannot be created without knowing where it
         * is going. So the address travels on the fact.
         *
         * Sending it rather than having shipping call back for it also fixes
         * the value at the moment of confirmation. A frozen address on a frozen
         * event is the same address forever; a callback would read whatever the
         * order says whenever the consumer happens to run.
         */
        payload: {
          orderId: order.id,
          customerId: order.customerId,
          currency: order.currency,
          totalMinor: order.totalMinor,
          shippingMinor: order.shippingMinor,
          shippingRateCode: order.shippingRateCode ?? null,
          shippingAddress: order.shippingAddress ?? null,
        },
      });

      this.logger.log(`[saga ${orderId}] committed -> CONFIRMED`);
    });
  }

  /** Stock returned. The compensation is complete. */
  async onInventoryReleased(orderId: string, correlationId?: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_RELEASE, async (manager, order, saga) => {
      const reason = saga.lastError ?? order.failureReason ?? 'Order cancelled';

      order.status = OrderStatus.CANCELLED;
      order.failureReason = reason;
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPENSATED;

      await this.announceCancelled(manager, order, reason, correlationId);

      this.logger.log(`[saga ${orderId}] released -> CANCELLED`);
    });
  }

  /** Money returned. Now give the stock back too. */
  async onPaymentRefunded(orderId: string, correlationId?: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_REFUND, async (manager, _o, saga) => {
      saga.currentStep = SagaStep.AWAITING_RELEASE;

      await this.outbox.append(manager, {
        eventType: 'inventory.release_requested',
        aggregateId: orderId,
        correlationId,
        payload: { orderId, reason: saga.lastError ?? 'Refunded' },
      });

      this.logger.log(`[saga ${orderId}] refunded -> releasing stock`);
    });
  }

  /**
   * The hold lapsed before the saga finished.
   *
   * Inventory has already returned the stock, so there is nothing to release.
   * What happens next depends entirely on **whether the customer has paid**:
   *
   *   before payment (AWAITING_RESERVATION, AWAITING_PAYMENT)
   *     Nothing was taken. Cancel outright; there is nothing to undo.
   *
   *   after payment (AWAITING_COMMIT)
   *     The card was charged and the order cannot be fulfilled, so the money
   *     must go back. Hand over to the ordinary refund compensation rather than
   *     cancelling here.
   *
   * That distinction was missing until M8's end-to-end testing surfaced it: an
   * order whose commit failed sat at AWAITING_COMMIT until its hold lapsed, and
   * this handler then cancelled it and marked the saga COMPENSATED **with the
   * payment still authorized and no refund**. The stock came back; the money
   * did not. The saga reported success for an outcome that had taken a
   * customer's money for nothing.
   *
   * Any other step means compensation is already under way — a release or a
   * refund is in flight — so expiry is a no-op rather than a second decision.
   */
  async onReservationExpired(orderId: string, correlationId?: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const saga = await manager.findOne(OrderSagaEntity, { where: { orderId } });
      const order = await manager.findOne(OrderEntity, { where: { id: orderId } });

      if (!saga || !order || saga.outcome !== SagaOutcome.RUNNING) {
        return;
      }

      const reason = 'Reservation expired before the order completed';

      if (saga.currentStep === SagaStep.AWAITING_COMMIT) {
        // Paid, but the stock is gone. Refund first; the order is cancelled
        // when the refund and the (already no-op) release come back, so it is
        // never shown as cancelled while the money is still held.
        saga.currentStep = SagaStep.AWAITING_REFUND;
        saga.compensating = true;
        saga.lastError = reason;

        await manager.save(OrderSagaEntity, saga);

        await this.outbox.append(manager, {
          eventType: 'payment.refund_requested',
          aggregateId: orderId,
          correlationId: correlationId ?? saga.correlationId ?? undefined,
          payload: { orderId, reason },
        });

        this.logger.warn(`[saga ${orderId}] expired after payment -> refunding`);
        return;
      }

      if (
        saga.currentStep !== SagaStep.AWAITING_RESERVATION &&
        saga.currentStep !== SagaStep.AWAITING_PAYMENT
      ) {
        // Already compensating. Whatever is in flight owns the outcome.
        this.logger.debug(`[saga ${orderId}] expiry ignored on step ${saga.currentStep}`);
        return;
      }

      order.status = OrderStatus.CANCELLED;
      order.failureReason = reason;
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPENSATED;
      saga.lastError = reason;

      await manager.save(OrderEntity, order);
      await manager.save(OrderSagaEntity, saga);
      await this.announceCancelled(manager, order, reason, correlationId);

      this.logger.warn(`[saga ${orderId}] reservation expired -> CANCELLED`);
    });
  }

  /**
   * Say out loud that an order is cancelled.
   *
   * Until M9 the saga reached its terminal states silently: it set a status and
   * stopped. Nothing needed to know, so nothing was published — the five events
   * orders emitted were all either the creation fact or commands aimed at
   * another service.
   *
   * A coupon changes that. A held redemption has to go back when the order it
   * was held for dies, and pricing cannot learn that by listening to
   * `inventory.release_requested`: that is a command addressed to inventory, and
   * the naming convention in HANDOFF §3 exists precisely so a routing key tells
   * you the direction of control. Eavesdropping on someone else's instruction
   * would work right up until the day inventory stops needing one.
   *
   * So `order.cancelled` is a fact, published from the four places an order can
   * reach that state, in the same transaction as the status change like every
   * other event here. `order.confirmed` is its twin, emitted on the happy path.
   * Both are leaf events — nothing consumes them to drive the saga forward — so
   * no transition depends on them and no compensation path moves.
   *
   * M15's notification service and M14's recommendations both want exactly
   * these two. Emitting them now with one consumer is cheaper than retrofitting
   * them later with four.
   */
  private async announceCancelled(
    manager: EntityManager,
    order: OrderEntity,
    reason: string,
    correlationId?: string,
  ): Promise<void> {
    await this.outbox.append(manager, {
      eventType: 'order.cancelled',
      aggregateId: order.id,
      correlationId,
      payload: {
        orderId: order.id,
        customerId: order.customerId,
        reason,
      },
    });
  }

  /**
   * Re-drive sagas that are still running.
   *
   * Called on startup. A saga can be stranded when the process died after
   * committing a transition but the reply was lost, or when a consumer nacked a
   * message. Re-emitting the command it is waiting for is safe because every
   * consumer is idempotent: if the work was already done, the repeat is a
   * no-op; if it was not, it now happens.
   */
  async resumeAll(): Promise<number> {
    const stuck = await this.dataSource.getRepository(OrderSagaEntity).find({
      where: { outcome: SagaOutcome.RUNNING },
      take: 200,
    });

    let resumed = 0;

    for (const saga of stuck) {
      const command = COMMAND_FOR_STEP[saga.currentStep];
      if (!command) {
        // AWAITING_PAYMENT waits on the customer and a Stripe webhook. Nothing
        // to re-send: re-requesting payment would create a second intent.
        continue;
      }

      await this.dataSource.transaction(async (manager) => {
        await this.outbox.append(manager, {
          eventType: command,
          aggregateId: saga.orderId,
          correlationId: saga.correlationId,
          payload: { orderId: saga.orderId, reason: saga.lastError ?? 'Saga resumed' },
        });

        saga.attempts += 1;
        await manager.save(OrderSagaEntity, saga);
      });

      this.logger.warn(
        `[saga ${saga.orderId}] resumed at ${saga.currentStep} (attempt ${saga.attempts})`,
      );
      resumed += 1;
    }

    return resumed;
  }

  getSaga(orderId: string): Promise<OrderSagaEntity | null> {
    return this.dataSource.getRepository(OrderSagaEntity).findOne({ where: { orderId } });
  }

  /**
   * Apply one transition, but only from the step we expect.
   *
   * The `expected` guard is what makes every handler idempotent: a redelivered
   * reply finds the saga has already moved on and does nothing, rather than
   * transitioning a second time.
   */
  private async transition(
    orderId: string,
    expected: SagaStep,
    apply: (manager: EntityManager, order: OrderEntity, saga: OrderSagaEntity) => Promise<void>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const saga = await manager.findOne(OrderSagaEntity, { where: { orderId } });
      const order = await manager.findOne(OrderEntity, { where: { id: orderId } });

      if (!saga || !order) {
        this.logger.warn(`[saga ${orderId}] no saga or order found; ignoring`);
        return;
      }

      if (saga.currentStep !== expected) {
        this.logger.debug(
          `[saga ${orderId}] expected ${expected} but at ${saga.currentStep}; ignoring`,
        );
        return;
      }

      await apply(manager, order, saga);

      await manager.save(OrderEntity, order);
      await manager.save(OrderSagaEntity, saga);
    });
  }
}

/**
 * The command to re-send when resuming a saga stuck at each step.
 *
 * Declared as data rather than a switch so the whole recovery policy is
 * readable at a glance — including the steps that deliberately have none.
 */
const COMMAND_FOR_STEP: Partial<Record<SagaStep, string>> = {
  [SagaStep.AWAITING_COMMIT]: 'inventory.commit_requested',
  [SagaStep.AWAITING_RELEASE]: 'inventory.release_requested',
  [SagaStep.AWAITING_REFUND]: 'payment.refund_requested',
  // AWAITING_RESERVATION: order.created is already in the outbox; the relay
  // retries it on its own.
  // AWAITING_PAYMENT: waits on a human and a Stripe webhook.
};
