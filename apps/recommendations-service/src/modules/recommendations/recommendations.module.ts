import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductRecommendationEntity } from './product-recommendation.entity';

/**
 * Recommendations module: co-purchase graph derived from order facts.
 * Per M14 plan §5 (Option A).
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProductRecommendationEntity])],
  exports: [TypeOrmModule],
})
export class RecommendationsModule {}
