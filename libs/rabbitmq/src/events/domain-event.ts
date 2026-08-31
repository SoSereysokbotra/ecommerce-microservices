/**
 * The envelope every message on the bus uses. See IMPLEMENTATION_PLAN.md §1.2.
 *
 * `eventId` is the idempotency key consumers deduplicate on.
 * `correlationId` follows one user action across every service.
 */
export interface DomainEvent<T = unknown> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  aggregateId: string;
  correlationId: string;
  version: number;
  payload: T;
}

/** Event names are `<aggregate>.<past-tense-verb>` — facts, never commands. */
export function buildEvent<T>(input: {
  eventType: string;
  aggregateId: string;
  correlationId: string;
  payload: T;
  eventId?: string;
  version?: number;
}): DomainEvent<T> {
  return {
    eventId: input.eventId ?? crypto.randomUUID(),
    eventType: input.eventType,
    occurredAt: new Date().toISOString(),
    aggregateId: input.aggregateId,
    correlationId: input.correlationId,
    version: input.version ?? 1,
    payload: input.payload,
  };
}
