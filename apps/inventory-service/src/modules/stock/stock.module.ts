import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockEntity } from './stock.entity';
import { ReservationEntity } from './reservation.entity';
import { ReservationsService } from './reservations.service';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';

@Module({
  imports: [TypeOrmModule.forFeature([StockEntity, ReservationEntity])],
  controllers: [StockController],
  providers: [StockService, ReservationsService],
  exports: [StockService, ReservationsService],
})
export class StockModule {}
