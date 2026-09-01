import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEventEntity } from './outbox-event.entity';
import { ProcessedEventEntity } from './processed-event.entity';
import { OutboxService } from './outbox.service';
import { OutboxRelay } from './outbox.relay';
import { IdempotencyService } from './idempotency.service';
import { OUTBOX_OPTIONS, OutboxOptions } from './outbox.options';

@Module({})
export class OutboxModule {
  static forRoot(options: OutboxOptions = {}): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      imports: [TypeOrmModule.forFeature([OutboxEventEntity, ProcessedEventEntity])],
      providers: [
        { provide: OUTBOX_OPTIONS, useValue: options },
        OutboxService,
        OutboxRelay,
        IdempotencyService,
      ],
      exports: [OutboxService, OutboxRelay, IdempotencyService],
    };
  }
}
