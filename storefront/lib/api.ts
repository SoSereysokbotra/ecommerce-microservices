/**
 * Thin client over the gateway.
 *
 * Everything goes through the gateway on one origin — the services behind it
 * are not reachable from a browser and should not be.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

const TOKEN_KEY = 'commerce.token';

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

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
};
