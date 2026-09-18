import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH, OpenSearchClient } from './opensearch.client';
import { ProductsProjection } from './products.projection';
import { AdminController } from './admin.controller';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Where every other service's `TypeOrmModule.forFeature([...])` would be.
 *
 * The raw client is a separate provider so tests can hand `OpenSearchClient`
 * a fake without a cluster. `SearchController` reads; the consumer in
 * `events/` writes through `ProductsProjection`; `AdminController` drops
 * and recreates the index empty. Nothing else touches it.
 */
@Module({
  providers: [
    {
      provide: OPENSEARCH,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Client({ node: config.getOrThrow<string>('OPENSEARCH_URL') }),
    },
    OpenSearchClient,
    ProductsProjection,
    SearchService,
  ],
  controllers: [SearchController, AdminController],
  exports: [OpenSearchClient, ProductsProjection],
})
export class SearchModule {}
