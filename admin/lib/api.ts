/**
 * Dedicated API Client for Admin Dashboard & Operations Console.
 *
 * Communicates strictly with the API Gateway (port 3000). Downstream microservices
 * remain unexposed and protected by the gateway's zero-trust perimeter.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

const TOKEN_KEY = 'admin.token';

export function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorPayload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAdminToken();

  // W3C traceparent (00-{traceId}-{spanId}-01) and correlation ID propagation from admin dashboard
  const traceId = (
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2)
  )
    .replace(/-/g, '')
    .padEnd(32, '0')
    .slice(0, 32);

  const spanId = (
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2)
  )
    .replace(/-/g, '')
    .slice(0, 16);

  const traceparent = `00-${traceId}-${spanId}-01`;
  const correlationId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `admin-${Date.now()}`;

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-correlation-id': correlationId,
      traceparent: traceparent,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let payload: unknown = undefined;
    try {
      payload = await response.json();
      const raw = (payload as { message?: string | string[] })?.message ?? message;
      message = Array.isArray(raw) ? raw.join(', ') : raw;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status, payload);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
