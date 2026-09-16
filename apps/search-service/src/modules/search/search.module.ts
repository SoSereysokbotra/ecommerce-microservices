import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH, OpenSearchClient } from './opensearch.client';

/**
 * Where every other service's `TypeOrmModule.forFeature([...])` would be.
 *
 * The raw client is a separate provider so tests can hand `OpenSearchClient`
 * a fake without a cluster. Controllers arrive with the query (step 4) and
 * the admin reset (step 5); the consumer lives in `events/` from step 3.
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
  ],
  exports: [OpenSearchClient],
})
export class SearchModule {}
