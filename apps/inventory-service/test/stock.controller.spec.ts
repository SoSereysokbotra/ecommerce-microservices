import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RolesGuard, ROLES_KEY, IS_PUBLIC_KEY } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { StockController } from '../src/modules/stock/stock.controller';
import { StockService } from '../src/modules/stock/stock.service';

describe('StockController - RBAC & Permissions', () => {
  let controller: StockController;
  let stockService: jest.Mocked<StockService>;
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(async () => {
    const mockStockService = {
      list: jest.fn(),
      findOne: jest.fn(),
      adjust: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StockController],
      providers: [
        {
          provide: StockService,
          useValue: mockStockService,
        },
      ],
    }).compile();

    controller = module.get<StockController>(StockController);
    stockService = module.get(StockService);
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(handler: Function, role?: string): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => StockController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: role ? { role } : undefined,
          headers: role ? { 'x-user-role': role } : {},
        }),
      }),
    } as unknown as ExecutionContext;
  }

  describe('Route metadata', () => {
    it('should have @Public on list and findOne', () => {
      const isListPublic = reflector.get(IS_PUBLIC_KEY, controller.list);
      const isFindOnePublic = reflector.get(IS_PUBLIC_KEY, controller.findOne);

      expect(isListPublic).toBe(true);
      expect(isFindOnePublic).toBe(true);
    });

    it('should have @Roles(ADMIN, STAFF) on adjust and set', () => {
      const adjustRoles = reflector.get(ROLES_KEY, controller.adjust);
      const setRoles = reflector.get(ROLES_KEY, controller.set);

      expect(adjustRoles).toEqual([UserRole.ADMIN, UserRole.STAFF]);
      expect(setRoles).toEqual([UserRole.ADMIN, UserRole.STAFF]);
    });
  });

  describe('Guard execution on adjust', () => {
    it('should allow ADMIN to adjust stock', () => {
      const ctx = createMockContext(controller.adjust, UserRole.ADMIN);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should allow STAFF to adjust stock', () => {
      const ctx = createMockContext(controller.adjust, UserRole.STAFF);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should forbid CUSTOMER from adjusting stock', () => {
      const ctx = createMockContext(controller.adjust, UserRole.CUSTOMER);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('should forbid unauthenticated caller from adjusting stock', () => {
      const ctx = createMockContext(controller.adjust);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });
});
