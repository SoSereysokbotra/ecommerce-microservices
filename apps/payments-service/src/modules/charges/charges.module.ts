import { Module } from '@nestjs/common';
import { ChargesController } from './charges.controller';

@Module({ controllers: [ChargesController] })
export class ChargesModule {}
