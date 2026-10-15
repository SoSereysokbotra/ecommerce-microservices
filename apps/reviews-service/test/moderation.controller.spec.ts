import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { ModerationController } from '../src/modules/reviews/moderation.controller';
import { ReviewsService } from '../src/modules/reviews/reviews.service';

describe('ModerationController', () => {
  let controller: ModerationController;
  let reviewsService: {
    listForModeration: jest.Mock;
    republish: jest.Mock;
    moderate: jest.Mock;
  };
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reviewsService = {
      listForModeration: jest.fn(),
      republish: jest.fn(async () => ({ ratings: 5 })),
      moderate: jest.fn(),
    };
    controller = new ModerationController(reviewsService as unknown as ReviewsService);
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(handler: Function, role?: string): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => ModerationController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: role ? { role } : undefined,
          headers: role ? { 'x-user-role': role } : {},
        }),
      }),
    } as unknown as ExecutionContext;
  }

  describe('RBAC & Role restrictions', () => {
    it('should have @Roles(ADMIN, STAFF) on ModerationController', () => {
      const classRoles = reflector.get(ROLES_KEY, ModerationController);
      expect(classRoles).toEqual([UserRole.ADMIN, UserRole.STAFF]);
    });

    it('should allow STAFF to access moderation', () => {
      const ctx = createMockContext(controller.listModeration, UserRole.STAFF);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should allow ADMIN to access moderation', () => {
      const ctx = createMockContext(controller.listModeration, UserRole.ADMIN);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should forbid CUSTOMER from accessing moderation', () => {
      const ctx = createMockContext(controller.listModeration, UserRole.CUSTOMER);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });

  describe('republish()', () => {
    it('delegates to ReviewsService.republish and returns { ratings: count }', async () => {
      const result = await controller.republish();

      expect(reviewsService.republish).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ratings: 5 });
    });
  });

  describe('approve()', () => {
    it('delegates to ReviewsService.moderate with action approve', async () => {
      reviewsService.moderate.mockResolvedValue({ id: 'r-1', status: 'approved' });

      const result = await controller.approve('r-1', { moderationNote: 'ok' });

      expect(reviewsService.moderate).toHaveBeenCalledWith('r-1', 'approve', 'ok');
      expect(result).toEqual({ id: 'r-1', status: 'approved' });
    });
  });

  describe('reject()', () => {
    it('delegates to ReviewsService.moderate with action reject', async () => {
      reviewsService.moderate.mockResolvedValue({ id: 'r-1', status: 'rejected' });

      const result = await controller.reject('r-1', { moderationNote: 'spam' });

      expect(reviewsService.moderate).toHaveBeenCalledWith('r-1', 'reject', 'spam');
      expect(result).toEqual({ id: 'r-1', status: 'rejected' });
    });
  });
});
