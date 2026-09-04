/**
 * Shapes the storefront consumes.
 *
 * Kept deliberately small and derived from the same fields the generated
 * OpenAPI types in libs/api-types describe. The previous project hand-mirrored
 * whole entity types and they silently drifted; these are narrow view models,
 * and `npm run gen:types` at the repo root is the source of truth for the
 * full contract.
 */
export interface Product {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description?: string | null;
  priceMinor: number;
  currency: string;
  active: boolean;
}

export interface Stock {
  productId: string;
  availableQty: number;
  reservedQty: number;
}

export type OrderStatus =
  | 'pending'
  | 'awaiting_payment'
  | 'confirmed'
  | 'cancelled'
  | 'failed';

export interface OrderItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineDiscountMinor: number;
  taxRateBp: number;
  taxMinor: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Null on orders placed before M8, which were taxed nowhere. */
  taxCountry?: string | null;
  taxRegion?: string | null;
  failureReason?: string | null;
  items: OrderItem[];
  createdAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  status: 'requires_payment' | 'authorized' | 'declined' | 'refunded';
  amountMinor: number;
  currency: string;
  clientSecret?: string | null;
  failureReason?: string | null;
}

export interface CartLine {
  productId: string;
  qty: number;
}

export type MergeReason = 'capped_to_stock' | 'out_of_stock' | 'unavailable';

export interface MergeAdjustment {
  productId: string;
  requestedQty: number;
  finalQty: number;
  reason: MergeReason;
}

export interface Cart {
  items: CartLine[];
  /** Present only on the response that merged a guest cart in. */
  merged?: { adjustments: MergeAdjustment[] };
  /** A token to store, or null once the guest cart has been consumed. */
  cartToken?: string | null;
}

// --- Pricing -------------------------------------------------------------

export interface Destination {
  country: string;
  region?: string | null;
}

export interface QuoteLine {
  productId: string;
  sku: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  lineDiscountMinor: number;
  taxableMinor: number;
  taxRateBp: number;
  taxMinor: number;
}

/**
 * One entry per tax rate in the basket.
 *
 * There is more than one whenever the basket mixes categories that are taxed
 * differently — Pennsylvania exempts clothing, so a basket with a shirt and a
 * mug has two. Tax is rounded once per group, so this is also the arithmetic
 * made checkable rather than merely displayed.
 */
export interface TaxGroup {
  rateBp: number;
  pricesIncludeTax: boolean;
  baseMinor: number;
  taxMinor: number;
}

export interface AppliedDiscount {
  id: string;
  name: string;
  amountMinor: number;
}

export interface Quote {
  currency: string;
  destination: { country: string; region: string | null };
  lines: QuoteLine[];
  subtotalMinor: number;
  discountMinor: number;
  appliedDiscounts: AppliedDiscount[];
  taxBreakdown: TaxGroup[];
  taxMinor: number;
  netMinor: number;
  totalMinor: number;
}

export interface TaxRate {
  id: string;
  country: string;
  region: string | null;
  category: string | null;
  rateBp: number;
  pricesIncludeTax: boolean;
  name: string;
}

/**
 * How to label the tax line.
 *
 * Inclusive and exclusive tax are different claims — "already in the price"
 * versus "added on top" — and showing both as a bare "Tax" row would hide that
 * from the only person it matters to.
 */
export function taxLabel(groups: TaxGroup[]): string {
  const charged = groups.filter((g) => g.rateBp > 0);
  if (charged.length === 0) return 'Tax';

  const inclusive = charged.every((g) => g.pricesIncludeTax);
  const rates = [...new Set(charged.map((g) => (g.rateBp / 100).toFixed(2).replace(/\.00$/, '')))];
  const noun = inclusive ? 'VAT' : 'Sales tax';

  return `${noun} (${rates.join(' + ')}%${inclusive ? ', included' : ''})`;
}

/** Money is integer minor units everywhere; format only at the edge. */
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
}
