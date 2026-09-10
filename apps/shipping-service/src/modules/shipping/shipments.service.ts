import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OutboxService } from '@libs/outbox';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ShipmentAddress, ShipmentEntity, ShipmentStatus } from './shipment.entity';

export interface CreateShipmentInput {
  orderId: string;
  customerId: string;
  rateCode: string | null;
  costMinor: number;
  weightG: number;
  address: ShipmentAddress | null;
}

/** What may follow what. The whole state machine, in one place. */
const ALLOWED_FROM: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.PENDING]: [ShipmentStatus.DISPATCHED],
  [ShipmentStatus.DISPATCHED]: [ShipmentStatus.DELIVERED],
  [ShipmentStatus.DELIVERED]: [],
};

/**
 * The shipment lifecycle.
 *
 * ## This is not a saga, and that is the interesting part
 *
 * `PROJECT_PLAN.md` §7 numbers "create shipment" as step 9 of the saga. It is
 * not one. The only question that decides whether something belongs in a saga
 * is **what has to be undone if it fails** — and for a shipment the answer is
 * nothing. The customer has paid, the stock is committed, the order is
 * `CONFIRMED`. A shipping service down for ten minutes is not a reason to
 * refund a completed order; it is a reason to create the shipment ten minutes
 * later, which redelivery already does.
 *
 * So the saga ends at `CONFIRMED`, no saga test changes, and this service
 * reacts to a fact rather than executing a step. A shipment that never gets
 * created despite retries is an *operational* failure — what M18's dead-letter
 * queue and M19's observability are for. See docs/M10_SHIPPING_PLAN.md §7.
 */
@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);

  constructor(
    @InjectRepository(ShipmentEntity)
    private readonly shipments: Repository<ShipmentEntity>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Create the shipment for a confirmed order, or do nothing if it exists.
   *
   * Called from inside the consumer's transaction, so the shipment and the
   * `processed_events` marker commit together.
   *
   * `ON CONFLICT DO NOTHING` rather than "check then insert". M9 learned this
   * twice over: a read-then-write leaves a window two deliveries can both pass
   * through, and catching a unique violation instead **aborts the whole
   * Postgres transaction**, so the marker written afterwards would never
   * commit and the event would be redelivered forever. Branching on zero rows
   * returned is the only version that is both correct and recoverable.
   */
  async createForOrder(
    manager: EntityManager,
    input: CreateShipmentInput,
  ): Promise<ShipmentEntity | null> {
    const rows: { id: string }[] = await manager.query(
      `INSERT INTO shipments (order_id, customer_id, status, rate_code, cost_minor, weight_g, address)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [
        input.orderId,
        input.customerId,
        input.rateCode,
        input.costMinor,
        input.weightG,
        input.address ? JSON.stringify(input.address) : null,
      ],
    );

    // INSERT ... RETURNING gives plain rows; UPDATE ... RETURNING gives
    // [rows, count]. Both shapes are silent when assumed wrongly — HANDOFF §5.
    if (rows.length === 0) {
      return null;
    }

    return manager.findOneByOrFail(ShipmentEntity, { id: rows[0].id });
  }

  findByOrder(orderId: string, customerId: string): Promise<ShipmentEntity | null> {
    // Scoped by customer for the same reason addresses are: somebody else's
    // shipment must be indistinguishable from one that does not exist.
    return this.shipments.findOne({ where: { orderId, customerId } });
  }

  dispatch(
    id: string,
    details: { carrier?: string; trackingCode?: string } = {},
  ): Promise<ShipmentEntity> {
    return this.transition(id, ShipmentStatus.DISPATCHED, (shipment) => {
      shipment.dispatchedAt = new Date();
      shipment.carrier = details.carrier ?? shipment.carrier;
      shipment.trackingCode = details.trackingCode ?? shipment.trackingCode;
    });
  }

  deliver(id: string): Promise<ShipmentEntity> {
    return this.transition(id, ShipmentStatus.DELIVERED, (shipment) => {
      shipment.deliveredAt = new Date();
    });
  }

  /**
   * Move a shipment, or refuse.
   *
   * The guard is `ALLOWED_FROM`, and refusing is the point: delivering a parcel
   * nobody dispatched is not a shortcut, it is a record that has lost track of
   * reality. The same reasoning as the saga's step guard, which refuses a
   * transition unless the saga is on the step it expects.
   *
   * The status change and its event share a transaction — the outbox pattern,
   * unchanged since M3. A dispatch that commits cannot fail to be announced,
   * and an announcement cannot exist for a dispatch that rolled back.
   */
  private async transition(
    id: string,
    to: ShipmentStatus,
    apply: (shipment: ShipmentEntity) => void,
  ): Promise<ShipmentEntity> {
    return this.dataSource.transaction(async (manager) => {
      // FOR UPDATE, because two operators clicking Dispatch at the same moment
      // is exactly the read-modify-write M8 found in inventory's stock rows.
      const shipment = await manager.findOne(ShipmentEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!shipment) {
        throw new NotFoundException(`Shipment '${id}' not found`);
      }

      if (!ALLOWED_FROM[shipment.status].includes(to)) {
        throw new ConflictException(
          `Shipment '${id}' is ${shipment.status} and cannot become ${to}` +
            `${ALLOWED_FROM[shipment.status].length === 0 ? ' — that is a terminal state' : ''}`,
        );
      }

      shipment.status = to;
      apply(shipment);

      const saved = await manager.save(shipment);

      /**
       * `shipment.dispatched` and `shipment.delivered` have **no consumer yet**.
       *
       * That is worth saying plainly, because HANDOFF §7 is rightly
       * self-critical about `cart.abandoned` being "the one piece of M7 written
       * for an imagined future". The argument for emitting these anyway is
       * narrower than "M15 will want them": the outbox is already here for the
       * consumer, and a state transition that leaves no trace on the bus is the
       * one thing this project has consistently treated as a defect. If that
       * does not convince, deleting these two appends costs nothing else.
       */
      await this.outbox.append(manager, {
        eventType: to === ShipmentStatus.DISPATCHED ? 'shipment.dispatched' : 'shipment.delivered',
        aggregateId: saved.id,
        payload: {
          shipmentId: saved.id,
          orderId: saved.orderId,
          customerId: saved.customerId,
          status: saved.status,
          carrier: saved.carrier,
          trackingCode: saved.trackingCode,
        },
      });

      this.logger.log(`Shipment ${saved.id} (order ${saved.orderId}) -> ${saved.status}`);
      return saved;
    });
  }
}
