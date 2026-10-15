import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RolesGuard, ROLES_KEY, IS_PUBLIC_KEY } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { ProductsController } from '../src/modules/products/products.controller';
import { ProductsService } from '../src/modules/products/products.service';

describe('ProductsController - RBAC & Permissions', () => {
  let controller: ProductsController;
  let productsService: jest.Mocked<ProductsService>;
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(async () => {
    const mockProductsService = {
      list: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        {
          provide: ProductsService,
          useValue: mockProductsService,
        },
      ],
    }).compile();

    controller = module.get<ProductsController>(ProductsController);
    productsService = module.get(ProductsService);
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(handler: Function, role?: string): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => ProductsController,
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

    it('should have @Roles(ADMIN, STAFF) on create and update', () => {
      const createRoles = reflector.get(ROLES_KEY, controller.create);
      const updateRoles = reflector.get(ROLES_KEY, controller.update);

      expect(createRoles).toEqual([UserRole.ADMIN, UserRole.STAFF]);
      expect(updateRoles).toEqual([UserRole.ADMIN, UserRole.STAFF]);
    });
  });

  describe('Guard execution on create', () => {
    it('should allow ADMIN to create product', () => {
      const ctx = createMockContext(controller.create, UserRole.ADMIN);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should allow STAFF to create product', () => {
      const ctx = createMockContext(controller.create, UserRole.STAFF);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should forbid CUSTOMER from creating product', () => {
      const ctx = createMockContext(controller.create, UserRole.CUSTOMER);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('should forbid unauthenticated caller from creating product', () => {
      const ctx = createMockContext(controller.create);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });
});
