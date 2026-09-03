import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartEntity } from './cart.entity';
import { CartItemEntity } from './cart-item.entity';
import { GuestCartStore } from './guest-cart.store';
import { UserCartStore } from './user-cart.store';

/**
 * Steps 2-3 of M7: both stores, no HTTP surface yet. The merge trigger and the
 * controller arrive in step 4 - see docs/M7_CART_PLAN.md §11.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CartEntity, CartItemEntity])],
  providers: [UserCartStore, GuestCartStore],
  exports: [UserCartStore, GuestCartStore],
})
export class CartModule {}
