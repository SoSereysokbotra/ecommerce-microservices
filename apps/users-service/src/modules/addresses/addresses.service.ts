import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AddressEntity } from './address.entity';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * The address book.
 *
 * **Every method takes a `userId` and scopes by it.** Not as belt-and-braces
 * over some other check — it is the only check there is. There are no roles
 * until M16, so an address belonging to somebody else must be indistinguishable
 * from one that does not exist: a 404, never a 403. A 403 confirms the id is
 * real, which is a small oracle but a free one.
 */
@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(AddressEntity)
    private readonly addresses: Repository<AddressEntity>,
    private readonly dataSource: DataSource,
  ) {}

  list(userId: string): Promise<AddressEntity[]> {
    // Default first, then newest — the order a checkout page wants to render.
    return this.addresses.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string): Promise<AddressEntity> {
    const address = await this.addresses.findOne({ where: { id, userId } });

    if (!address) {
      throw new NotFoundException(`Address '${id}' not found`);
    }
    return address;
  }

  async create(userId: string, input: CreateAddressDto): Promise<AddressEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AddressEntity);

      // The first address a customer saves is their default whether they asked
      // or not. A book with no default means checkout pre-selects nothing,
      // which is a worse first experience than a guess that is always right.
      const isFirst = (await repo.count({ where: { userId } })) === 0;
      const wantsDefault = input.isDefault === true || isFirst;

      if (wantsDefault) {
        await this.clearDefault(manager.getRepository(AddressEntity), userId);
      }

      return repo.save(repo.create({ ...input, userId, isDefault: wantsDefault }));
    });
  }

  async update(userId: string, id: string, input: UpdateAddressDto): Promise<AddressEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AddressEntity);
      const address = await repo.findOne({ where: { id, userId } });

      if (!address) {
        throw new NotFoundException(`Address '${id}' not found`);
      }

      // Clearing the old default and setting the new one are two writes, and
      // the partial unique index refuses the moment they disagree — so they
      // share a transaction. See the migration.
      if (input.isDefault === true && !address.isDefault) {
        await this.clearDefault(repo, userId);
      }

      return repo.save(Object.assign(address, input));
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.addresses.delete({ id, userId });

    if (result.affected === 0) {
      throw new NotFoundException(`Address '${id}' not found`);
    }
    // Deliberately does not promote another address to default. Deleting one
    // is not a statement about which of the rest should take its place, and a
    // checkout with nothing pre-selected is a prompt, not a failure.
  }

  private clearDefault(repo: Repository<AddressEntity>, userId: string): Promise<unknown> {
    // Raw-ish update rather than load-then-save: this touches at most one row
    // and there is nothing to read.
    return repo.update({ userId, isDefault: true }, { isDefault: false });
  }
}
