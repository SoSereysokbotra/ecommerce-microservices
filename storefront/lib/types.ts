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
}

export interface Order {
  id: string;
  status: OrderStatus;
  currency: string;
  totalMinor: number;
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

/** Money is integer minor units everywhere; format only at the edge. */
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
}
