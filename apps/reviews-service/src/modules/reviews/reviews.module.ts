import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseEntity } from './purchase.entity';
import { ReviewEntity } from './review.entity';
import { ProductRatingEntity } from './product-rating.entity';
import { PurchasesService } from './purchases.service';
import { ReviewsService } from './reviews.service';
import { UsersClient } from './users.client';
import { ReviewsController } from './reviews.controller';
import { ModerationController } from './moderation.controller';

/**
 * Reviews module: reviews lifecycle, verified purchase eligibility,
 * moderation queue and the product rating rollup.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PurchaseEntity, ReviewEntity, ProductRatingEntity])],
  controllers: [ReviewsController, ModerationController],
  providers: [PurchasesService, ReviewsService, UsersClient],
  exports: [PurchasesService, ReviewsService],
})
export class ReviewsModule {}
