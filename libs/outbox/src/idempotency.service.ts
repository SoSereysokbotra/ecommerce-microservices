import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ProcessedEventEntity } from './processed-event.entity';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Run `work` at most once for this (eventId, consumer) pair.
   *
   * The marker insert and the work share one transaction, which is the entire
   * guarantee. Insert the marker first and commit separately, and a crash before
   * the work leaves the event marked done but never performed. Do the work first
   * and a crash before the marker repeats it. Together in one transaction, both
   * happen or neither does.
   *
   * Returns true if the work ran, false if this event had already been handled.
   */
  async handleOnce(
    eventId: string,
    consumer: string,
    work: (manager: import('typeorm').EntityManager) => Promise<void>,
  ): Promise<boolean> {
    try {
      await this.dataSource.transaction(async (manager) => {
        // Claim the event. A duplicate delivery loses the race here and the
        // unique violation aborts the transaction before `work` can run again.
        await manager.insert(ProcessedEventEntity, {
          eventId,
          consumer,
          processedAt: new Date(),
        });

        await work(manager);
      });

      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.debug(`Event ${eventId} already handled by ${consumer}; skipping`);
        return false;
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as unknown as { code?: string }).code === UNIQUE_VIOLATION
  );
}
