import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrencyEntity } from './currency.entity';

/**
 * Reads the currency table.
 *
 * Nothing converts yet — that is step 2 of docs/M11_CURRENCY_PLAN.md §13. This
 * exists so the exponent has one source of truth from the first commit, rather
 * than being hardcoded in the browser and then un-hardcoded later.
 */
@Injectable()
export class CurrencyService {
  constructor(
    @InjectRepository(CurrencyEntity)
    private readonly currencies: Repository<CurrencyEntity>,
  ) {}

  list(): Promise<CurrencyEntity[]> {
    return this.currencies.find({ where: { active: true }, order: { code: 'ASC' } });
  }

  /**
   * One currency, or a 404.
   *
   * Refusing an unknown code rather than defaulting to exponent 2 is the whole
   * point: a silent default is exactly the assumption this milestone exists to
   * remove, and it would be wrong for precisely the currencies that matter.
   */
  async require(code: string): Promise<CurrencyEntity> {
    const currency = await this.currencies.findOne({ where: { code: code.toUpperCase() } });

    if (!currency) {
      throw new NotFoundException(`Unknown currency '${code}'`);
    }
    return currency;
  }
}
