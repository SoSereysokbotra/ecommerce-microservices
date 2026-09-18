import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH, OpenSearchClient } from './opensearch.client';
import { ProductsProjection } from './products.projection';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Where every other service's `TypeOrmModule.forFeature([...])` would be.
 *
 * The raw client is a separate provider so tests can hand `OpenSearchClient`
 * a fake without a cluster. `SearchController` reads; the consumer in
 * `events/` writes through `ProductsProjection`; nothing else touches the
 * index until the admin reset (step 5).
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
  controllers: [SearchController],
  exports: [OpenSearchClient, ProductsProjection],
})
export class SearchModule {}
