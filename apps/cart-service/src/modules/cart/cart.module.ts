import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartEntity } from './cart.entity';
import { CartItemEntity } from './cart-item.entity';
import { UserCartStore } from './user-cart.store';

/**
 * Step 2 of M7: the Postgres side only. The Redis guest store, the merge
 * trigger and the HTTP surface arrive in later steps — see
 * docs/M7_CART_PLAN.md §11.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CartEntity, CartItemEntity])],
  providers: [UserCartStore],
  exports: [UserCartStore],
})
export class CartModule {}
