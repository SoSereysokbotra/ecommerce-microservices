export const OUTBOX_OPTIONS = 'OUTBOX_OPTIONS';

export interface OutboxOptions {
  /** How often the relay looks for unpublished rows. Default 1000ms. */
  pollIntervalMs?: number;
  /** Rows per cycle. Default 50. */
  batchSize?: number;
}
