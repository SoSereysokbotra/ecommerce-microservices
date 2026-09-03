'use client';

import Link from 'next/link';
import { useCart } from './CartProvider';

/** Header link showing how many items are waiting. */
export function CartLink() {
  const { count, loading } = useCart();

  return (
    <Link href="/cart" data-testid="cart-link">
      Cart{!loading && count > 0 ? ` (${count})` : ''}
    </Link>
  );
}
