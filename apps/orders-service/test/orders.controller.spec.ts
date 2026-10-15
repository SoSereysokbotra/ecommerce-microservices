import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@libs/shared-types';
import { ROLES_KEY } from '@libs/common';
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';
import { ReplayController } from '../src/modules/orders/replay.controller';
import { ReplayService } from '../src/modules/orders/replay.service';
import { OrderEntity, OrderStatus } from '../src/modules/orders/order.entity';

describe('OrdersController - Ownership Scoping & Staff Overrides', () => {
  let controller: OrdersController;
  let ordersService: jest.Mocked<OrdersService>;

  const mockOrder: OrderEntity = {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    customerId: 'cust-1',
    status: OrderStatus.PENDING,
    currency: 'USD',
    subtotalMinor: 1000,
    taxMinor: 100,
    shippingMinor: 500,
    discountMinor: 0,
    totalMinor: 1600,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
  };

  beforeEach(async () => {
    const mockOrdersService = {
      create: jest.fn(),
      list: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        {
          provide: OrdersService,
          useValue: mockOrdersService,
        },
      ],
    }).compile();

    controller = module.get<OrdersController>(OrdersController);
    ordersService = module.get(OrdersService);
  });

  describe('list', () => {
    it('scopes query to caller when caller is CUSTOMER', async () => {
      ordersService.list.mockResolvedValue([mockOrder]);

      const result = await controller.list('cust-1', UserRole.CUSTOMER, 'cust-2');
      expect(result).toEqual([mockOrder]);
      // Ignores filterCustomerId parameter and scopes strictly to caller's own id
      expect(ordersService.list).toHaveBeenCalledWith('cust-1');
    });

    it('allows STAFF to query all orders or filter by customerId', async () => {
      ordersService.list.mockResolvedValue([mockOrder]);

      await controller.list('staff-1', UserRole.STAFF, 'cust-2');
      expect(ordersService.list).toHaveBeenCalledWith('cust-2');

      await controller.list('staff-1', UserRole.STAFF, undefined);
      expect(ordersService.list).toHaveBeenCalledWith(undefined);
    });

    it('allows ADMIN to query all orders', async () => {
      ordersService.list.mockResolvedValue([mockOrder]);

      await controller.list('admin-1', UserRole.ADMIN, undefined);
      expect(ordersService.list).toHaveBeenCalledWith(undefined);
    });
  });

  describe('findOne', () => {
    it('scopes by customerId when caller is CUSTOMER', async () => {
      ordersService.findOne.mockResolvedValue(mockOrder);

      const result = await controller.findOne(
        'cust-1',
        UserRole.CUSTOMER,
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      );
      expect(result).toEqual(mockOrder);
      expect(ordersService.findOne).toHaveBeenCalledWith(
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        'cust-1',
      );
    });

    it('throws NotFoundException when customer requests an order belonging to someone else', async () => {
      ordersService.findOne.mockResolvedValue(null);

      await expect(
        controller.findOne('cust-2', UserRole.CUSTOMER, '3fa85f64-5717-4562-b3fc-2c963f66afa6'),
      ).rejects.toThrow(NotFoundException);

      expect(ordersService.findOne).toHaveBeenCalledWith(
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        'cust-2',
      );
    });

    it('allows STAFF to view any customer order without customerId filter', async () => {
      ordersService.findOne.mockResolvedValue(mockOrder);

      const result = await controller.findOne(
        'staff-1',
        UserRole.STAFF,
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      );
      expect(result).toEqual(mockOrder);
      expect(ordersService.findOne).toHaveBeenCalledWith(
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        undefined,
      );
    });
  });

  describe('ReplayController RBAC', () => {
    it('has @Roles(ADMIN, STAFF) metadata on ReplayController', () => {
      const reflector = new Reflector();
      const roles = reflector.get(ROLES_KEY, ReplayController);
      expect(roles).toEqual([UserRole.ADMIN, UserRole.STAFF]);
    });
  });
});
