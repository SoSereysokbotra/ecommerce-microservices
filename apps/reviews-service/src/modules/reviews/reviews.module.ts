import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseEntity } from './purchase.entity';
import { ReviewEntity } from './review.entity';
import { ProductRatingEntity } from './product-rating.entity';
import { PurchasesService } from './purchases.service';

/**
 * Step 2 is the scaffold: the entities and the purchase recorder, which is
 * all the `order.confirmed` consumer needs. Reviews, moderation and the
 * rollup arrive at step 3 (docs/M13_REVIEWS_PLAN.md §11).
 */
@Module({
  imports: [TypeOrmModule.forFeature([PurchaseEntity, ReviewEntity, ProductRatingEntity])],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class ReviewsModule {}
