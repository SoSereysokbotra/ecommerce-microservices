import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CORRELATION_ID_HEADER, USER_ID_HEADER } from '@libs/common';

/** An address as users-service returns it. */
export interface CustomerAddress {
  id: string;
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postcode: string | null;
  country: string;
  phone: string | null;
}

/**
 * Reads one of the customer's saved addresses at checkout.
 *
 * ## Why this call exists at all
 *
 * Since M8 the tax destination has travelled **on the request** — the client
 * says where it is going and pricing believes it — because nothing in the
 * system knew a customer's address. That was labelled a placeholder for M10 in
 * `docs/M8_PRICING_PLAN.md` §5, and this is where it stops being one. When the
 * order names a `shippingAddressId`, the country and region come from a row
 * this customer owns, read server-side, rather than from a field the browser
 * filled in. A client can still choose *which* of their addresses to use; it
 * can no longer invent one in a tax-free jurisdiction.
 *
 * The client-supplied `destination` is kept for guests and for a checkout with
 * no saved address, so this is a narrowing rather than a replacement.
 *
 * ## Why it is safe to be a synchronous read
 *
 * Same argument as `PricingClient` and, before it, the catalog lookup: it runs
 * **before anything commits**, so a failure rejects the request cleanly with
 * nothing left half-done (HANDOFF §7). It is one more service that must be up
 * to place an order, not a new kind of failure.
 *
 * ## How it authenticates
 *
 * It does not carry the customer's bearer token — orders never sees one, only
 * the `x-user-id` the gateway wrote after verifying the JWT. So it passes that
 * id on, and users-service scopes the lookup by it. An address belonging to
 * somebody else comes back 404, which this turns into a 404 for the order.
 */
@Injectable()
export class UsersClient {
  private readonly logger = new Logger(UsersClient.name);
  private readonly baseUrl = (process.env.USERS_SERVICE_URL ?? 'http://users-service:3001').replace(
    /\/$/,
    '',
  );
  private readonly timeoutMs = Number(process.env.USERS_TIMEOUT_MS ?? 3000);

  async address(
    customerId: string,
    addressId: string,
    correlationId?: string,
  ): Promise<CustomerAddress> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/users/me/addresses/${encodeURIComponent(addressId)}`,
        {
          headers: {
            [USER_ID_HEADER]: customerId,
            ...(correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {}),
          },
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        // Either it does not exist or it is not theirs, and those must be
        // indistinguishable — see AddressesService.
        throw new NotFoundException(`Address '${addressId}' not found`);
      }

      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Could not read the delivery address (HTTP ${response.status})`,
        );
      }

      return (await response.json()) as CustomerAddress;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`address lookup failed: ${reason} [${correlationId ?? '-'}]`);
      throw new ServiceUnavailableException(`Could not reach users-service: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
