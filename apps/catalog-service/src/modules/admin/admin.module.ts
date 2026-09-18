import { Module } from '@nestjs/common';
import { RepublishController } from './republish.controller';
import { RepublishService } from './republish.service';

/**
 * No `TypeOrmModule.forFeature` — the republish walks both tables through the
 * `DataSource` directly, inside one transaction, and needs no repository.
 * `OutboxService` comes from the global `OutboxModule` in `AppModule`.
 */
@Module({
  controllers: [RepublishController],
  providers: [RepublishService],
})
export class AdminModule {}
