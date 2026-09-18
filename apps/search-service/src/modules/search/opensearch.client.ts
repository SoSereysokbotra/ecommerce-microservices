import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client, errors } from '@opensearch-project/opensearch';
import { PRODUCTS_INDEX, PRODUCTS_INDEX_BODY } from './products.index';

export const OPENSEARCH = 'OPENSEARCH';

export type ClusterStatus = 'green' | 'yellow' | 'red';

/**
 * The only thing in search-service that talks to OpenSearch.
 *
 * A thin wrapper, not an abstraction: the projection (step 3) and the query
 * (step 4) use the official client through `raw` directly. What lives here is
 * the part every caller needs settled before it runs — that the `products`
 * index exists with the right mapping — and the readiness probe.
 *
 * The index is created on boot if missing. Creation is idempotent in the
 * only way that matters: two instances racing to create it both succeed,
 * because the loser's `resource_already_exists_exception` is treated as
 * "exists", not as a failure. It is *not* upgraded if the mapping has
 * changed — that is a reindex, which is `POST /search/admin/recreate-index`
 * (step 5) followed by the write-side republish.
 */
@Injectable()
export class OpenSearchClient implements OnModuleInit {
  private readonly logger = new Logger(OpenSearchClient.name);

  constructor(@Inject(OPENSEARCH) readonly raw: Client) {}

  /**
   * Boot-time bootstrap. A failure here is logged, not thrown: OpenSearch is
   * a JVM that takes a while, and `/ready` retries the same call on every
   * probe, so the service comes up as soon as the cluster does rather than
   * crash-looping behind it.
   */
  async onModuleInit(): Promise<void> {
    try {
      const outcome = await this.ensureIndex();
      this.logger.log(`Index "${PRODUCTS_INDEX}" ${outcome}`);
    } catch (error) {
      this.logger.warn(
        `OpenSearch not reachable at boot (${errorMessage(error)}); /ready will keep trying`,
      );
    }
  }

  /** Creates the `products` index with its mapping if it does not exist. */
  async ensureIndex(): Promise<'created' | 'exists'> {
    const exists = await this.raw.indices.exists({ index: PRODUCTS_INDEX });
    if (exists.body) {
      return 'exists';
    }

    try {
      await this.raw.indices.create({ index: PRODUCTS_INDEX, body: PRODUCTS_INDEX_BODY });
      return 'created';
    } catch (error) {
      if (isAlreadyExists(error)) {
        return 'exists';
      }
      throw error;
    }
  }

  /**
   * Drop the index and create it empty with the current mapping.
   *
   * This is the **only** reset. Deleting documents one at a time does not
   * work with external versioning — a deleted document's version survives
   * as a tombstone for `index.gc_deletes` (60 s) and refuses anything not
   * newer (HANDOFF §5). Dropping the index drops the tombstones with it.
   *
   * The index is empty when this returns. Nothing here refills it: that is
   * the write side's job (`POST /catalog/admin/republish`), which is the
   * point — the read side cannot rebuild itself without reading a database
   * it must not read.
   */
  async recreateIndex(): Promise<void> {
    await this.raw.indices.delete({ index: PRODUCTS_INDEX }, { ignore: [404] });
    await this.raw.indices.create({ index: PRODUCTS_INDEX, body: PRODUCTS_INDEX_BODY });
    this.logger.warn(`Index "${PRODUCTS_INDEX}" dropped and recreated empty`);
  }

  /**
   * The cluster's own verdict. Throws when the cluster cannot be reached at
   * all, which `/ready` turns into a 503.
   *
   * `red` is also returned, not thrown: the caller decides what a red cluster
   * means. For readiness it means "not ready" — a red single node cannot
   * serve the one index it has.
   */
  async clusterStatus(): Promise<ClusterStatus> {
    const response = await this.raw.cluster.health({}, { requestTimeout: 3000 });
    return response.body.status as ClusterStatus;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof errors.ResponseError &&
    error.body?.error?.type === 'resource_already_exists_exception'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
