import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockEntity } from './stock.entity';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';
import { ReservationsController } from './reservations.controller';

@Module({
  imports: [TypeOrmModule.forFeature([StockEntity])],
  controllers: [StockController, ReservationsController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
