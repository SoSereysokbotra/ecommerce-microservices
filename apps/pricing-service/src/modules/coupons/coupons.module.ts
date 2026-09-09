import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CouponEntity } from './coupon.entity';
import { CouponRedemptionEntity } from './coupon-redemption.entity';
import { CouponsService } from './coupons.service';

@Module({
  imports: [TypeOrmModule.forFeature([CouponEntity, CouponRedemptionEntity])],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
