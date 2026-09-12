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
  /** What delivery cost. Zero before M10, and zero when it was free. */
  shippingMinor: number;
  /** Which service level was charged. Null for orders placed before M10. */
  shippingRateCode?: string | null;
  /** Where it is going, frozen at checkout. */
  shippingAddress?: Omit<Address, 'id' | 'isDefault' | 'label'> | null;
  totalMinor: number;
  /** Decimal places for `currency`. Null before M11, which means two. */
  exponent?: number | null;
  baseCurrency?: string | null;
  fxRateE8?: number | null;
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

/** What a coupon code did to the basket, and if nothing, why. */
export interface QuoteCoupon {
  code: string;
  applied: boolean;
  amountMinor: number;
  rejectedBecause: string | null;
}

/** Why a code was refused, in words a shopper can act on. */
export const COUPON_REJECTIONS: Record<string, string> = {
  not_found: 'We do not recognise that code.',
  inactive: 'That code is no longer available.',
  not_started: 'That code is not active yet.',
  expired: 'That code has expired.',
  exhausted: 'That code has been fully claimed.',
  per_customer_limit: 'You have already used that code.',
  already_redeemed: 'That code is already applied to this order.',
};

/** One delivery service level, priced for this basket. */
export interface ShippingOption {
  code: string;
  name: string;
  costMinor: number;
  /** True when a free-shipping threshold zeroed an otherwise real price. */
  freeApplied: boolean;
  /** The price before the threshold, so the saving can be shown. */
  listPriceMinor: number;
  currency: string;
}

/** What delivery options a basket has, and which one is in the total. */
export interface QuoteShipping {
  /** Null when nothing ships to this destination. */
  zone: string | null;
  weightGrams: number;
  options: ShippingOption[];
  selectedCode: string | null;
  /** True when a requested code is not on offer — express dropped out, say. */
  requestedCodeUnavailable: boolean;
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
  /** Delivery as charged. In an inclusive-tax region it already contains VAT. */
  shippingMinor: number;
  /** Delivery's share of taxMinor — already inside it, not additional. */
  shippingTaxMinor: number;
  netMinor: number;
  totalMinor: number;
  coupon?: QuoteCoupon | null;
  shipping?: QuoteShipping | null;
  /** Decimal places for `currency`. Zero for JPY — pass it to formatMoney. */
  exponent: number;
  /** What the catalog priced the goods in. */
  baseCurrency: string;
  /** The rate used × 10^8. 100000000 at parity. */
  fxRateE8: number;
}

/** A saved delivery address. */
export interface Address {
  id: string;
  label?: string | null;
  recipient: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode?: string | null;
  country: string;
  phone?: string | null;
  isDefault: boolean;
}

export type ShipmentStatus = 'pending' | 'dispatched' | 'delivered';

export interface Shipment {
  id: string;
  orderId: string;
  status: ShipmentStatus;
  rateCode: string | null;
  costMinor: number;
  address: Omit<Address, 'id' | 'isDefault' | 'label'> | null;
  carrier: string | null;
  trackingCode: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
}

/** What each shipment state means to somebody waiting for a parcel. */
export const SHIPMENT_LABELS: Record<ShipmentStatus, string> = {
  pending: 'Preparing your parcel',
  dispatched: 'On its way',
  delivered: 'Delivered',
};

/** One line of an address, in the order a label is written. */
export function formatAddress(address: Address | Shipment['address']): string {
  if (!address) return '';
  return [
    address.recipient,
    address.line1,
    address.line2,
    address.city,
    [address.region, address.postcode].filter(Boolean).join(' '),
    address.country,
  ]
    .filter((part) => part && String(part).trim() !== '')
    .join(', ');
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

/**
 * Money is integer minor units everywhere; format only at the edge.
 *
 * `exponent` is how many minor units make one unit — **2 for USD and EUR, 0
 * for JPY**. Until M11 this function divided by a literal 100, which showed
 * ¥10.00 for a ¥1000 item and was wrong by a factor of a hundred for every
 * currency that is not hundredths. The exponent comes from the quote or the
 * order, so the browser holds no table of its own that could drift from the
 * one pricing uses.
 *
 * Defaults to 2 for the callers that predate M11 and only ever see the base
 * currency; a JPY figure formatted without its exponent would be a bug at the
 * call site, and `Intl` would at least render it without decimals.
 */
export function formatMoney(amountMinor: number, currency: string, exponent = 2): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    amountMinor / 10 ** exponent,
  );
}

export interface Currency {
  code: string;
  /** Minor-unit exponent. Zero for JPY. */
  exponent: number;
  name: string;
}
