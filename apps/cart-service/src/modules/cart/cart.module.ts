import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { CartEntity } from './cart.entity';
import { CartItemEntity } from './cart-item.entity';
import { GuestCartStore } from './guest-cart.store';
import { InventoryClient } from './inventory.client';
import { UserCartStore } from './user-cart.store';

/**
 * Steps 2-4 of M7. What is still missing: the order.created consumer that
 * clears a cart (step 5) and the abandonment job (step 7).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CartEntity, CartItemEntity])],
  controllers: [CartController],
  providers: [CartService, UserCartStore, GuestCartStore, InventoryClient],
  exports: [CartService, UserCartStore, GuestCartStore],
})
export class CartModule {}
