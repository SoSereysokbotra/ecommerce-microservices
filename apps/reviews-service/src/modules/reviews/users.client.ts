import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  CORRELATION_ID_HEADER,
  TRACEPARENT_HEADER,
  USER_ID_HEADER,
  getTraceparent,
} from '@libs/common';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
}

/**
 * Reads a user profile from users-service to snapshot author_name at review creation.
 *
 * ## Why author_name is snapshotted
 *
 * A review shows an author name. The gateway forwards an id and role (`x-user-id`,
 * `x-user-role`), not a name, and the browser cannot be trusted to supply one.
 * Reading the author name from users-service snapshots it onto the review at
 * creation time. A later name change does not rewrite historical reviews,
 * preserving provenance exactly as `order_items` snapshots the product name.
 *
 * ## Error mapping style (HANDOFF §7, M13_REVIEWS_PLAN.md §6)
 *
 * Mirrors `apps/orders-service/src/modules/orders/users.client.ts`:
 * an unreachable upstream is a 503 Service Unavailable, NOT a 400 Bad Request.
 * Telling a client their review is malformed when the users service is merely
 * down misleads callers into thinking their request cannot succeed.
 */
@Injectable()
export class UsersClient {
  private readonly logger = new Logger(UsersClient.name);
  private readonly baseUrl = (process.env.USERS_SERVICE_URL ?? 'http://users-service:3001').replace(
    /\/$/,
    '',
  );
  private readonly timeoutMs = Number(process.env.USERS_TIMEOUT_MS ?? 3000);

  async getUser(userId: string, correlationId?: string): Promise<UserProfile> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/users/${encodeURIComponent(userId)}`, {
        headers: {
          [USER_ID_HEADER]: userId,
          ...(correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {}),
          ...(getTraceparent() ? { [TRACEPARENT_HEADER]: getTraceparent() } : {}),
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new NotFoundException(`User '${userId}' not found`);
      }

      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Could not read user profile (HTTP ${response.status})`,
        );
      }

      return (await response.json()) as UserProfile;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`User profile lookup failed: ${reason} [${correlationId ?? '-'}]`);
      throw new ServiceUnavailableException(`Could not reach users-service: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
