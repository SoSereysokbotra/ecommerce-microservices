import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { OrderSagaEntity } from './order-saga.entity';
import { OrderSagaService } from './order-saga.service';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ReplayController } from './replay.controller';
import { ReplayService } from './replay.service';
import { PricingClient } from './pricing.client';
import { UsersClient } from './users.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([OrderEntity, OrderItemEntity, OrderSagaEntity]),
    HttpModule.register({ timeout: 5000 }),
  ],
  controllers: [OrdersController, ReplayController],
  providers: [OrdersService, OrderSagaService, PricingClient, UsersClient, ReplayService],
  exports: [OrdersService, OrderSagaService, ReplayService],
})
export class OrdersModule {}
