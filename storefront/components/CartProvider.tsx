'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCartToken } from '@/lib/api';
import type { Cart, CartLine, MergeAdjustment } from '@/lib/types';

interface CartContextValue {
  items: CartLine[];
  count: number;
  loading: boolean;
  /** Set once by a merge, until dismissed, so the shopper is told what changed. */
  adjustments: MergeAdjustment[] | null;
  dismissAdjustments: () => void;
  refresh: () => Promise<void>;
  addItem: (productId: string, qty: number) => Promise<void>;
  setQty: (productId: string, qty: number) => Promise<void>;
  removeItem: (productId: string) => Promise<void>;
  clear: () => Promise<void>;
}

const CartContext = createContext<CartContextValue | null>(null);

/**
 * One source of truth for the cart, so the header count and the cart page can
 * never disagree.
 *
 * It also owns the guest cart token. Every cart response may carry a
 * `cartToken`: a string to store when the server has just minted one, or `null`
 * once a guest cart has been merged into a signed-in one and the client should
 * forget it. Handling that here means no page has to remember to.
 */
export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [adjustments, setAdjustments] = useState<MergeAdjustment[] | null>(null);

  const absorb = useCallback((cart: Cart) => {
    setItems(cart.items ?? []);

    if (cart.cartToken !== undefined) {
      setCartToken(cart.cartToken);
    }

    // Only surfaced when something actually changed; an empty list would be a
    // notice that says nothing.
    if (cart.merged?.adjustments?.length) {
      setAdjustments(cart.merged.adjustments);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      absorb(await api.get<Cart>('/cart'));
    } catch {
      // A cart that will not load must not break the page it is rendered in.
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [absorb]);

  // Loaded inline rather than by calling refresh(), which the react-hooks
  // lint rule reads as setting state directly from an effect. The cancelled
  // flag stops a slow response from writing into an unmounted provider.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const cart = await api.get<Cart>('/cart');
        if (!cancelled) absorb(cart);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [absorb]);

  const addItem = useCallback(
    async (productId: string, qty: number) => {
      absorb(await api.post<Cart>('/cart/items', { productId, qty }));
    },
    [absorb],
  );

  const setQty = useCallback(
    async (productId: string, qty: number) => {
      absorb(await api.patch<Cart>(`/cart/items/${productId}`, { qty }));
    },
    [absorb],
  );

  const removeItem = useCallback(
    async (productId: string) => {
      absorb(await api.del<Cart>(`/cart/items/${productId}`));
    },
    [absorb],
  );

  const clear = useCallback(async () => {
    absorb(await api.del<Cart>('/cart'));
  }, [absorb]);

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      count: items.reduce((total, line) => total + line.qty, 0),
      loading,
      adjustments,
      dismissAdjustments: () => setAdjustments(null),
      refresh,
      addItem,
      setQty,
      removeItem,
      clear,
    }),
    [items, loading, adjustments, refresh, addItem, setQty, removeItem, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used inside a CartProvider');
  }
  return context;
}
