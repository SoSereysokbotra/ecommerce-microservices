import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A set of destinations that share a price list.
 *
 * Zones are matched by **priority**, highest first, and that is the whole
 * algorithm. `US-CA` (priority 30) beats `US` (20) beats `ROW` (0), so a
 * Californian address gets the local price list and a Pennsylvanian one falls
 * back to the national list without either row knowing about the other.
 *
 * An explicit integer was chosen over deriving specificity from how many fields
 * are set — the trick `resolveTaxRule()` uses in pricing-service. That works
 * there because a tax rule has exactly two nullable dimensions. Here a zone is a
 * *set* of countries, and "how specific is `['DE','FR','NL']`?" has no honest
 * answer. A number in the seed can be read and argued with; a derived score
 * cannot.
 *
 * Overlap between zones is allowed and resolved by priority. Overlap is a
 * feature: `US-CA` deliberately overlaps `US`.
 */
@Entity({ name: 'shipping_zones' })
export class ShippingZoneEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stable natural key: 'US-CA', 'US', 'EU', 'ROW'. What the seed matches on. */
  @Column({ type: 'varchar', unique: true })
  code: string;

  /** Human label. Shown nowhere yet; read by whoever is debugging a rate. */
  @Column({ type: 'varchar' })
  name: string;

  /**
   * ISO 3166-1 alpha-2 codes this zone covers.
   *
   * **Empty means every country**, which is how `ROW` is expressed. Null would
   * have been the more usual spelling of "any", but an array column that is
   * sometimes null and sometimes a list needs two branches at every use site,
   * and `cardinality(countries) = 0` reads the same in SQL and in TypeScript.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  countries: string[];

  /**
   * State or province codes, when the zone is narrower than a country.
   *
   * Null means "the whole country" — and unlike `countries`, null is right here:
   * a destination with no region must still match a country-wide zone, but must
   * **not** match a region-scoped one. `$region = ANY(regions)` is already NULL,
   * and therefore not true, for a destination with no region, so the two cases
   * fall out of one comparison.
   */
  @Column({ type: 'text', array: true, nullable: true })
  regions: string[] | null;

  /** Highest wins. Ties are broken by `code` so selection is deterministic. */
  @Column({ type: 'integer', default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
