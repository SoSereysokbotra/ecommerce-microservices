import { randomBytes } from 'crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { CartLine } from './cart-merge';

const KEY_PREFIX = 'cart:guest:';

/**
 * A guest cart token is a **bearer credential**: whoever holds it owns that
 * cart. Unguessability is the only thing protecting it, so the token is 24
 * random bytes rather than anything derived from the request.
 */
const TOKEN_BYTES = 24;

/** base64url of 24 bytes is always 32 chars. Anything else was not issued here. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

interface StoredCart {
  items: CartLine[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The anonymous shopper's cart, in Redis.
 *
 * Redis rather than Postgres because most guest carts are abandoned and never
 * become orders. A TTL expires them without a cleanup job, which is the mirror
 * image of the signed-in cart in `UserCartStore` — that one must survive, so it
 * lives in Postgres and needs the abandonment sweep instead.
 *
 * The interface deliberately mirrors `UserCartStore`: `CartLine[]` in,
 * `CartLine[]` out, so the service layer above can treat the two the same.
 */
@Injectable()
export class GuestCartStore implements OnModuleDestroy {
  private readonly logger = new Logger(GuestCartStore.name);
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
      // A guest cart is a convenience, never the source of truth for an order.
      // Queueing commands forever behind a dead Redis would turn its outage
      // into hung requests, so fail fast and let the caller degrade.
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });

    this.redis.on('error', (error: Error) => {
      // Logged, not thrown: ioredis reconnects on its own, and an unhandled
      // 'error' event would take the process down.
      this.logger.warn(`Redis error: ${error.message}`);
    });

    const days = Number(process.env.CART_GUEST_TTL_DAYS ?? 30);
    this.ttlSeconds = Math.max(1, Math.floor(days * 24 * 60 * 60));
  }

  /** Mint a token for a shopper who does not have one yet. */
  newToken(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
  }

  /**
   * Tokens arrive from a client header, so they are validated before ever being
   * concatenated into a Redis key. This keeps keys well-formed and bounded, and
   * means a malformed token reads as an empty cart rather than an error.
   */
  isValidToken(token: string | undefined | null): token is string {
    return typeof token === 'string' && TOKEN_PATTERN.test(token);
  }

  async getItems(token: string): Promise<CartLine[]> {
    const cart = await this.read(token);
    return cart?.items ?? [];
  }

  /** Add to an existing line rather than replacing it, matching UserCartStore. */
  async addItem(token: string, productId: string, qty: number): Promise<CartLine[]> {
    const items = await this.getItems(token);
    const existing = items.find((item) => item.productId === productId);

    if (existing) {
      existing.qty += qty;
    } else {
      items.push({ productId, qty });
    }

    return this.write(token, items);
  }

  /**
   * Set an absolute quantity; zero or less removes the line.
   *
   * Updated **in place** rather than removed and re-appended. UserCartStore
   * returns its lines by `created_at`, so rebuilding the array here would make
   * the same call reorder a guest cart but not a signed-in one, and the cart
   * would visibly reshuffle every time a quantity changed.
   */
  async setItemQty(token: string, productId: string, qty: number): Promise<CartLine[]> {
    const items = await this.getItems(token);
    const index = items.findIndex((item) => item.productId === productId);

    if (qty <= 0) {
      if (index >= 0) {
        items.splice(index, 1);
      }
    } else if (index >= 0) {
      items[index].qty = qty;
    } else {
      items.push({ productId, qty });
    }

    return this.write(token, items);
  }

  async removeItem(token: string, productId: string): Promise<CartLine[]> {
    return this.setItemQty(token, productId, 0);
  }

  async replaceItems(token: string, lines: readonly CartLine[]): Promise<CartLine[]> {
    return this.write(token, [...lines]);
  }

  /**
   * Drop the guest cart entirely. Called once its contents have been merged
   * into a signed-in cart — unlike `UserCartStore.clear`, there is no row worth
   * keeping, because nothing sweeps guest carts.
   */
  async discard(token: string): Promise<void> {
    if (!this.isValidToken(token)) {
      return;
    }

    await this.redis.del(this.keyFor(token));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  private keyFor(token: string): string {
    return `${KEY_PREFIX}${token}`;
  }

  private async read(token: string): Promise<StoredCart | null> {
    if (!this.isValidToken(token)) {
      return null;
    }

    const raw = await this.redis.get(this.keyFor(token));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as StoredCart;
      // Whatever wrote this key may have been an older build, so the contents
      // are treated as input rather than trusted. cart-merge makes the same
      // assumption for the same reason.
      return {
        ...parsed,
        items: Array.isArray(parsed.items) ? parsed.items.filter(isUsableLine) : [],
      };
    } catch {
      this.logger.warn(`Discarding unparseable guest cart ${token.slice(0, 6)}...`);
      await this.redis.del(this.keyFor(token));
      return null;
    }
  }

  private async write(token: string, items: CartLine[]): Promise<CartLine[]> {
    if (!this.isValidToken(token)) {
      throw new Error('invalid guest cart token');
    }

    const usable = items.filter(isUsableLine);
    const now = new Date().toISOString();

    if (usable.length === 0) {
      // An empty guest cart is indistinguishable from no cart, so do not keep
      // a key alive for one.
      await this.redis.del(this.keyFor(token));
      return [];
    }

    const existing = await this.read(token);
    const payload: StoredCart = {
      items: usable,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // TTL is reset on every write, so an actively used cart does not expire
    // mid-shop. Reads deliberately do not extend it: a cart nobody has touched
    // for the whole window is exactly what the expiry is for.
    await this.redis.set(this.keyFor(token), JSON.stringify(payload), 'EX', this.ttlSeconds);

    return usable;
  }
}

function isUsableLine(line: CartLine): boolean {
  return (
    typeof line?.productId === 'string' &&
    line.productId.length > 0 &&
    Number.isInteger(line.qty) &&
    line.qty > 0
  );
}
