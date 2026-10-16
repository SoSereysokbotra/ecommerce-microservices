import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, ROLES_KEY, UserRole } from '@libs/common';
import { CouponsController } from '../src/modules/coupons/coupons.controller';
import { CouponsService } from '../src/modules/coupons/coupons.service';
import { PricingController } from '../src/modules/pricing/pricing.controller';
import { PricingService } from '../src/modules/pricing/pricing.service';

describe('Pricing & Coupons RBAC Protection', () => {
  const reflector = new Reflector();

  describe('CouponsController', () => {
    let controller: CouponsController;
    let service: jest.Mocked<CouponsService>;

    beforeEach(() => {
      service = {
        resolve: jest.fn(),
        hold: jest.fn(),
        release: jest.fn(),
        createCoupon: jest.fn(),
        deleteCoupon: jest.fn(),
        listCoupons: jest.fn(),
      } as unknown as jest.Mocked<CouponsService>;

      controller = new CouponsController(service);
    });

    it('marks validate, hold, and release as @Public()', () => {
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, controller.validate)).toBe(true);
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, controller.hold)).toBe(true);
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, controller.release)).toBe(true);
    });

    it('protects listCoupons with @Roles(ADMIN, STAFF)', () => {
      const listRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.listCoupons);
      expect(listRoles).toContain(UserRole.ADMIN);
      expect(listRoles).toContain(UserRole.STAFF);
    });

    it('protects createCoupon and deleteCoupon with @Roles(ADMIN)', () => {
      const createRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.createCoupon);
      expect(createRoles).toContain(UserRole.ADMIN);

      const deleteRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.deleteCoupon);
      expect(deleteRoles).toContain(UserRole.ADMIN);
    });

    it('delegates createCoupon to service', async () => {
      const input = { code: 'SAVE10', discountId: 'd-1', maxUses: 50 };
      const fakeCoupon = { id: 'c-1', code: 'SAVE10' } as any;
      service.createCoupon.mockResolvedValue(fakeCoupon);

      const result = await controller.createCoupon(input);
      expect(result).toBe(fakeCoupon);
      expect(service.createCoupon).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'SAVE10', discountId: 'd-1' }),
      );
    });

    it('delegates deleteCoupon to service', async () => {
      service.deleteCoupon.mockResolvedValue(true);

      const result = await controller.deleteCoupon('SAVE10');
      expect(result).toEqual({ deleted: true });
      expect(service.deleteCoupon).toHaveBeenCalledWith('SAVE10');
    });
  });

  describe('PricingController', () => {
    let controller: PricingController;
    let service: jest.Mocked<PricingService>;

    beforeEach(() => {
      service = {
        quote: jest.fn(),
        listTaxRates: jest.fn(),
        createTaxRate: jest.fn(),
        listDiscounts: jest.fn(),
      } as unknown as jest.Mocked<PricingService>;

      controller = new PricingController(service);
    });

    it('marks quote, taxRates, and discounts as @Public()', () => {
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, controller.quote)).toBe(true);
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, controller.taxRates)).toBe(true);
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, controller.discounts)).toBe(true);
    });

    it('protects createTaxRate with @Roles(ADMIN)', () => {
      const taxRateRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.createTaxRate);
      expect(taxRateRoles).toContain(UserRole.ADMIN);
    });

    it('delegates createTaxRate to service', async () => {
      const input = { country: 'US', region: 'NY', rateBp: 800, name: 'NY Tax' };
      const fakeTaxRate = { id: 't-1', country: 'US', rateBp: 800 } as any;
      service.createTaxRate.mockResolvedValue(fakeTaxRate);

      const result = await controller.createTaxRate(input);
      expect(result).toBe(fakeTaxRate);
      expect(service.createTaxRate).toHaveBeenCalledWith(input);
    });
  });
});
