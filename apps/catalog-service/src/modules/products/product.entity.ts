import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'products' })
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  sku: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Integer minor units — 1999 means $19.99. Never a float: binary floating
   * point cannot represent most decimal fractions exactly, and money that is
   * off by a cent is money that is wrong.
   */
  @Column({ name: 'price_minor', type: 'integer' })
  priceMinor: number;

  @Column({ length: 3 })
  currency: string;

  /**
   * Shipping weight in grams. Integer, for the same reason prices are integers:
   * this number is compared against band boundaries and decides what a customer
   * pays to have the thing delivered.
   *
   * Defaults to 0, which rates into the lightest band. A product nobody has
   * weighed yet must still ship — see the M10 migration for why that is
   * preferable to a nullable column.
   */
  @Column({ name: 'weight_grams', type: 'integer', default: 0 })
  weightGrams: number;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId?: string | null;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
