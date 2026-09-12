/**
 * Thin client over the gateway.
 *
 * Everything goes through the gateway on one origin — the services behind it
 * are not reachable from a browser and should not be.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

const TOKEN_KEY = 'commerce.token';

/**
 * Identifies a guest cart. A header rather than a cookie, because the
 * storefront and the gateway are on different origins and a cookie would be
 * third-party — see docs/M7_CART_PLAN.md §3. It is a bearer credential for an
 * anonymous cart holding only product ids and quantities, which is strictly
 * less sensitive than the auth token already stored the same way.
 */
const CART_TOKEN_KEY = 'commerce.cartToken';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function getCartToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(CART_TOKEN_KEY);
}

/** Passing null clears it — which is what the server asks for after a merge. */
export function setCartToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token === null) {
    window.localStorage.removeItem(CART_TOKEN_KEY);
  } else {
    window.localStorage.setItem(CART_TOKEN_KEY, token);
  }
}

/**
 * The destination a basket is priced for.
 *
 * Stored here, beside the cart token, because until M10 nothing in the system
 * knows a customer's address — the destination travels on the request, so the
 * browser is where the shopper's choice lives. Once shipping addresses exist
 * this becomes a default rather than the source of truth.
 */
const DESTINATION_KEY = 'commerce.destination';

export interface StoredDestination {
  country: string;
  region?: string | null;
}

export function getDestination(): StoredDestination | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(DESTINATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredDestination;
    // Written by an older build, or by hand. Treat it as untrusted rather than
    // sending nonsense to the API and rendering the validation error.
    return typeof parsed?.country === 'string' && parsed.country.length === 2 ? parsed : null;
  } catch {
    window.localStorage.removeItem(DESTINATION_KEY);
    return null;
  }
}

export function setDestination(destination: StoredDestination): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DESTINATION_KEY, JSON.stringify(destination));
}

/**
 * Which saved address and delivery speed the shopper picked.
 *
 * Beside the destination, and for the same reason: the choice belongs to this
 * browser between page loads. Unlike the destination it is not the source of
 * truth for anything — the order sends the **address id**, and the server reads
 * the address itself, so a stale or tampered value here cannot change where the
 * order is taxed. See docs/M10_SHIPPING_PLAN.md §3.
 */
const SHIPPING_KEY = 'commerce.shipping';

export interface StoredShipping {
  addressId?: string | null;
  rateCode?: string | null;
}

export function getShippingChoice(): StoredShipping {
  if (typeof window === 'undefined') return {};
  const raw = window.localStorage.getItem(SHIPPING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StoredShipping;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    window.localStorage.removeItem(SHIPPING_KEY);
    return {};
  }
}

export function setShippingChoice(choice: StoredShipping): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SHIPPING_KEY, JSON.stringify(choice));
}

/**
 * The currency the shopper chose to see prices in.
 *
 * A global choice, not a cart one, so it lives in the header rather than on the
 * cart page. Independent of the destination: "Germany means euros" is a guess
 * that is wrong for every expat, so the two are never conflated.
 *
 * Not the source of truth for anything. The order sends the code, pricing does
 * the conversion server-side, and the rate used is frozen onto the order.
 */
const CURRENCY_KEY = 'commerce.currency';

export function getCurrency(): string | null {
  if (typeof window === 'undefined') return null;
  const code = window.localStorage.getItem(CURRENCY_KEY);
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

export function setCurrency(code: string | null): void {
  if (typeof window === 'undefined') return;
  if (code === null) {
    window.localStorage.removeItem(CURRENCY_KEY);
  } else {
    window.localStorage.setItem(CURRENCY_KEY, code.toUpperCase());
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const cartToken = getCartToken();

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Sent alongside the JWT on purpose: a request carrying both is exactly
      // what triggers the guest cart being merged into the signed-in one.
      ...(cartToken ? { 'x-cart-token': cartToken } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    // The gateway returns one error shape everywhere, so this handles all of
    // them — including the 503 it synthesises when a service is unreachable.
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      const raw = body.message ?? message;
      message = Array.isArray(raw) ? raw.join(', ') : raw;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
