import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductRecommendationEntity } from './product-recommendation.entity';
import { RecommendationsService } from './recommendations.service';
import { CatalogClient } from './catalog.client';
import { RecommendationsController } from './recommendations.controller';
import { AdminController } from './admin.controller';

/**
 * Recommendations module: co-purchase graph derived from order facts,
 * enriched with catalog details. Per M14 plan §5 (Option A) & §13 step 3.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProductRecommendationEntity])],
  controllers: [RecommendationsController, AdminController],
  providers: [RecommendationsService, CatalogClient],
  exports: [TypeOrmModule, RecommendationsService, CatalogClient],
})
export class RecommendationsModule {}
