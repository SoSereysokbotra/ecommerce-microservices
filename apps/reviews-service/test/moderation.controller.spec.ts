import { ModerationController } from '../src/modules/reviews/moderation.controller';
import { ReviewsService } from '../src/modules/reviews/reviews.service';

describe('ModerationController', () => {
  let controller: ModerationController;
  let reviewsService: {
    listForModeration: jest.Mock;
    republish: jest.Mock;
    moderate: jest.Mock;
  };

  beforeEach(() => {
    reviewsService = {
      listForModeration: jest.fn(),
      republish: jest.fn(async () => ({ ratings: 5 })),
      moderate: jest.fn(),
    };
    controller = new ModerationController(reviewsService as unknown as ReviewsService);
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
