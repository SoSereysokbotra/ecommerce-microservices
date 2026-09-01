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
  async onReservationFailed(orderId: string, reason: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_RESERVATION, async (_m, order, saga) => {
      order.status = OrderStatus.CANCELLED;
      order.failureReason = reason;
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPENSATED;
      saga.lastError = reason;

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
  async onInventoryCommitted(orderId: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_COMMIT, async (_m, order, saga) => {
      order.status = OrderStatus.CONFIRMED;
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPLETED;

      this.logger.log(`[saga ${orderId}] committed -> CONFIRMED`);
    });
  }

  /** Stock returned. The compensation is complete. */
  async onInventoryReleased(orderId: string): Promise<void> {
    await this.transition(orderId, SagaStep.AWAITING_RELEASE, async (_m, order, saga) => {
      order.status = OrderStatus.CANCELLED;
      order.failureReason = saga.lastError ?? order.failureReason ?? 'Order cancelled';
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPENSATED;

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
   * Inventory has already returned the stock, so there is nothing to release —
   * the order just has to catch up with a decision made without it.
   */
  async onReservationExpired(orderId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const saga = await manager.findOne(OrderSagaEntity, { where: { orderId } });
      const order = await manager.findOne(OrderEntity, { where: { id: orderId } });

      if (!saga || !order || saga.outcome !== SagaOutcome.RUNNING) {
        return;
      }

      order.status = OrderStatus.CANCELLED;
      order.failureReason = 'Reservation expired before the order completed';
      saga.currentStep = SagaStep.DONE;
      saga.outcome = SagaOutcome.COMPENSATED;
      saga.lastError = order.failureReason;

      await manager.save(OrderEntity, order);
      await manager.save(OrderSagaEntity, saga);

      this.logger.warn(`[saga ${orderId}] reservation expired -> CANCELLED`);
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
