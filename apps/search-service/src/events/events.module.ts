import { Module } from '@nestjs/common';
import { SearchModule } from '../modules/search/search.module';
import { CatalogEventsListener } from './catalog-events.listener';

/**
 * The event side of search-service — and the only way anything gets into
 * the index. No controller writes a document; `POST /search/admin/*` (step 5)
 * only deletes and recreates the empty index, and the write side replays.
 */
@Module({
  imports: [SearchModule],
  providers: [CatalogEventsListener],
})
export class EventsModule {}
