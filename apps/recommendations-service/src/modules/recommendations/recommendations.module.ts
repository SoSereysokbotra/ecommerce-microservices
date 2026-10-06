import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductRecommendationEntity } from './product-recommendation.entity';
import { RecommendationsService } from './recommendations.service';

/**
 * Recommendations module: co-purchase graph derived from order facts.
 * Per M14 plan §5 (Option A).
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProductRecommendationEntity])],
  providers: [RecommendationsService],
  exports: [TypeOrmModule, RecommendationsService],
})
export class RecommendationsModule {}
