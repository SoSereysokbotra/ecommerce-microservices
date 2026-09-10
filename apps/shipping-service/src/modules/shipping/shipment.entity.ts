import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `PENDING → DISPATCHED → DELIVERED`, and nothing else.
 *
 * No `cancelled`: shipments are created from `order.confirmed`, so a cancelled
 * order never has one, and there is no returns flow until R4. A value nothing
 * writes is a value someone later has to reason about — see the migration.
 */
export enum ShipmentStatus {
  /** Created, nobody has picked it up yet. Where a parcel spends its first day. */
  PENDING = 'pending',
  /** Handed to the carrier. */
  DISPATCHED = 'dispatched',
  /** Terminal, and reached because a human or a carrier webhook said so. */
  DELIVERED = 'delivered',
}

/** The delivery address, as the shipment remembers it. */
export interface ShipmentAddress {
  recipient: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode?: string | null;
  country: string;
  phone?: string | null;
}

@Entity({ name: 'shipments' })
export class ShipmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Unique — the guard that makes creating a shipment idempotent under an
   * at-least-once bus. Enforced by `UQ_shipments_order`, not here; see the
   * migration for why both would be a mistake.
   */
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'enum', enum: ShipmentStatus, default: ShipmentStatus.PENDING })
  status: ShipmentStatus;

  /**
   * What was chosen and charged for, frozen at confirmation.
   *
   * Null for an order placed before M10, or one that named no rate. The
   * shipment still exists — something has to be sent — it simply has no
   * delivery service recorded against it.
   */
  @Column({ name: 'rate_code', type: 'varchar', nullable: true })
  rateCode: string | null;

  /** What the customer paid for delivery. Zero when it was free. */
  @Column({ name: 'cost_minor', type: 'integer', default: 0 })
  costMinor: number;

  /** What it was rated on. Kept so a disputed charge can be reconstructed. */
  @Column({ name: 'weight_g', type: 'integer', default: 0 })
  weightG: number;

  /**
   * Where it is going — a copy, taken from the `order.confirmed` event.
   *
   * Null when the order carried no address, which is every order placed before
   * M10 and any placed with only a `destination`. A shipment with no address is
   * a real operational problem, but it is not this service's to invent: it
   * records what it was told.
   */
  @Column({ type: 'jsonb', nullable: true })
  address: ShipmentAddress | null;

  /** Set at dispatch. Nothing populates these automatically yet. */
  @Column({ type: 'varchar', nullable: true })
  carrier: string | null;

  @Column({ name: 'tracking_code', type: 'varchar', nullable: true })
  trackingCode: string | null;

  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
