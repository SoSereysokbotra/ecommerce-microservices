import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReviewEntity, ReviewStatus } from '../src/modules/reviews/review.entity';
import { ProductRatingEntity } from '../src/modules/reviews/product-rating.entity';
import { PurchaseEntity } from '../src/modules/reviews/purchase.entity';
import { ReviewsService } from '../src/modules/reviews/reviews.service';

/**
 * ReviewsService state machine and eligibility tests without an external database.
 *
 * Requirements from docs/M13_REVIEWS_PLAN.md §4, §6, §11:
 *   - Only customers who bought can review (403 without a purchase row).
 *   - One review per customer per product (409 on second submission).
 *   - Snapshots author_name from users-service.
 *   - Every legal transition (pending->approved, pending->rejected, approved->rejected, rejected->approved).
 *   - Every illegal transition (approved->approved -> 409; rejected->rejected -> 409).
 *   - Rollup moves in the moderation transaction; edit of approved review subtracts and returns to pending.
 */
describe('ReviewsService', () => {
  const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
  const CUSTOMER_ID = '22222222-2222-2222-2222-222222222222';
  const OTHER_CUSTOMER_ID = '33333333-3333-3333-3333-333333333333';
  const REVIEW_ID = '44444444-4444-4444-4444-444444444444';
  const ORDER_ID = '55555555-5555-5555-5555-555555555555';

  function setup() {
    const reviews: ReviewEntity[] = [];
    let productRating: ProductRatingEntity | null = null;
    const purchases: PurchaseEntity[] = [];

    const reviewsRepo = {
      create: (dto: Partial<ReviewEntity>) =>
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...dto,
        }),
      save: jest.fn(async (review: ReviewEntity) => {
        const idx = reviews.findIndex((r) => r.id === review.id);
        if (idx >= 0) {
          reviews[idx] = review;
        } else {
          reviews.push(review);
        }
        return review;
      }),
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (
          reviews.find((r) => {
            return Object.entries(where).every(
              ([key, val]) => (r as unknown as Record<string, unknown>)[key] === val,
            );
          }) ?? null
        );
      }),
      findAndCount: jest.fn(
        async ({
          where,
          skip,
          take,
        }: {
          where: Record<string, unknown>;
          skip?: number;
          take?: number;
        }) => {
          const matches = reviews.filter((r) => {
            return Object.entries(where).every(
              ([key, val]) => (r as unknown as Record<string, unknown>)[key] === val,
            );
          });
          const sliced = matches.slice(skip ?? 0, (skip ?? 0) + (take ?? matches.length));
          return [sliced, matches.length];
        },
      ),
      find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return reviews.filter((r) => {
          return Object.entries(where).every(
            ([key, val]) => (r as unknown as Record<string, unknown>)[key] === val,
          );
        });
      }),
    };

    const ratingsRepo = {
      findOne: jest.fn(async () => productRating),
      save: jest.fn(async (rating: ProductRatingEntity) => {
        productRating = rating;
        return rating;
      }),
    };

    const purchasesService = {
      hasPurchased: jest.fn(async (_m: unknown, custId: string, prodId: string) => {
        return purchases.find((p) => p.customerId === custId && p.productId === prodId) ?? null;
      }),
    };

    const usersClient = {
      getUser: jest.fn(async (userId: string) => ({
        id: userId,
        name: 'Jane Doe',
        email: 'jane@example.com',
      })),
    };

    const outbox = {
      append: jest.fn(async () => undefined),
    };

    const manager = {
      findOne: jest.fn(async (entity: unknown, opts: { where: Record<string, unknown> }) => {
        if (entity === ReviewEntity) {
          return reviewsRepo.findOne(opts);
        }
        if (entity === ProductRatingEntity) {
          return productRating;
        }
        return null;
      }),
      save: jest.fn(async (entity: unknown, target: unknown) => {
        if (entity === ReviewEntity) {
          return reviewsRepo.save(target as ReviewEntity);
        }
        if (entity === ProductRatingEntity) {
          productRating = target as ProductRatingEntity;
          return productRating;
        }
        return target;
      }),
      /**
       * Raw SQL, mocked at the shape Postgres actually returns: **snake_case
       * column names**, not entity properties.
       *
       * This matters more than it looks. The first version of this mock spread
       * entities (`{ ...target }`), so the service could read `row.productId`
       * and every test passed — while live, `manager.query` returns
       * `product_id` and that read was `undefined`, which reached
       * `ratingAvgE2` as NaN and threw inside `BigInt()`. Every approval would
       * have 500'd. A mock that is kinder than the database tests nothing.
       */
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('UPDATE reviews')) {
          const targetStatus = params[0] as ReviewStatus;
          const note = params[1] as string | null;
          const id = params[2] as string;
          const allowed = params[3] as ReviewStatus[];

          const target = reviews.find((r) => r.id === id && allowed.includes(r.status));
          if (!target) {
            return [[], 0]; // 0 rows affected
          }
          const prevStatus = target.status;
          target.status = targetStatus;
          target.moderationNote = note;
          target.moderatedAt = new Date();
          target.version += 1;
          return [
            [
              {
                id: target.id,
                product_id: target.productId,
                customer_id: target.customerId,
                order_id: target.orderId,
                rating: target.rating,
                title: target.title,
                body: target.body,
                author_name: target.authorName,
                status: target.status,
                moderated_at: target.moderatedAt,
                moderation_note: target.moderationNote,
                version: target.version,
                prev_status: prevStatus,
              },
            ],
            1,
          ];
        }

        if (sql.includes('INSERT INTO product_ratings')) {
          const prodId = params[0] as string;
          const ratingVal = Number(params[1]);
          if (!productRating) {
            productRating = Object.assign(new ProductRatingEntity(), {
              productId: prodId,
              ratingSum: ratingVal,
              ratingCount: 1,
              version: 1,
              updatedAt: new Date(),
            });
          } else {
            productRating.ratingSum += ratingVal;
            productRating.ratingCount += 1;
            productRating.version += 1;
            productRating.updatedAt = new Date();
          }
          return [
            [
              {
                product_id: productRating.productId,
                rating_sum: productRating.ratingSum,
                rating_count: productRating.ratingCount,
                version: productRating.version,
                updated_at: productRating.updatedAt,
              },
            ],
            1,
          ];
        }

        if (sql.includes('UPDATE product_ratings')) {
          const ratingVal = Number(params[0]);
          if (productRating) {
            productRating.ratingSum = Math.max(0, productRating.ratingSum - ratingVal);
            productRating.ratingCount = Math.max(0, productRating.ratingCount - 1);
            productRating.version += 1;
            productRating.updatedAt = new Date();
            return [
              [
                {
                  product_id: productRating.productId,
                  rating_sum: productRating.ratingSum,
                  rating_count: productRating.ratingCount,
                  version: productRating.version,
                  updated_at: productRating.updatedAt,
                },
              ],
              1,
            ];
          }
          return [[], 0];
        }

        return [];
      }),
      find: jest.fn(async () => (productRating ? [productRating] : [])),
      // `moderate` re-reads the entity after its raw UPDATE, so the API
      // answers camelCase rather than the snake_case row.
      findOneByOrFail: jest.fn(async (_entity: unknown, where: { id: string }) => {
        const found = reviews.find((r) => r.id === where.id);
        if (!found) throw new Error(`no review ${where.id}`);
        return found;
      }),
    };

    const dataSource = {
      manager,
      transaction: async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
    };

    const service = new ReviewsService(
      dataSource as never,
      reviewsRepo as never,
      ratingsRepo as never,
      purchasesService as never,
      usersClient as never,
      outbox as never,
    );

    return {
      service,
      reviews,
      purchases,
      purchasesService,
      usersClient,
      outbox,
      setProductRating: (r: ProductRatingEntity) => {
        productRating = r;
      },
      getProductRating: () => productRating,
    };
  }

  describe('create()', () => {
    it('throws 403 Forbidden if customer has no purchase record for this product', async () => {
      const { service } = setup();

      await expect(
        service.create(CUSTOMER_ID, PRODUCT_ID, {
          rating: 5,
          title: 'Awesome item',
          body: 'Really liked it',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws 409 Conflict if customer has already reviewed this product', async () => {
      const { service, reviews, purchases } = setup();

      purchases.push(
        Object.assign(new PurchaseEntity(), {
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          orderId: ORDER_ID,
        }),
      );

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: 'existing-id',
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.APPROVED,
        }),
      );

      await expect(
        service.create(CUSTOMER_ID, PRODUCT_ID, {
          rating: 5,
          title: 'Second review attempt',
          body: 'Not allowed',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates a review with status pending, snapshots authorName, and does not touch rollup', async () => {
      const { service, purchases, usersClient, outbox } = setup();

      purchases.push(
        Object.assign(new PurchaseEntity(), {
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          orderId: ORDER_ID,
        }),
      );

      const review = await service.create(CUSTOMER_ID, PRODUCT_ID, {
        rating: 4,
        title: 'Solid build',
        body: 'Exceeded expectations',
      });

      expect(review.status).toBe(ReviewStatus.PENDING);
      expect(review.authorName).toBe('Jane Doe');
      expect(usersClient.getUser).toHaveBeenCalledWith(CUSTOMER_ID, undefined);
      expect(review.rating).toBe(4);
      expect(review.version).toBe(1);
      // New review in pending status does NOT emit rating_changed
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('throws 404 when review is not found', async () => {
      const { service } = setup();
      await expect(service.update('missing-id', CUSTOMER_ID, { title: 'Updated' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 403 when customer is not the review author', async () => {
      const { service, reviews } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.PENDING,
          rating: 4,
        }),
      );

      await expect(
        service.update(REVIEW_ID, OTHER_CUSTOMER_ID, { title: 'Hacked' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('editing a pending review updates fields and keeps status pending without outbox event', async () => {
      const { service, reviews, outbox } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.PENDING,
          rating: 3,
          title: 'Old Title',
          version: 1,
        }),
      );

      const updated = await service.update(REVIEW_ID, CUSTOMER_ID, {
        rating: 5,
        title: 'New Title',
      });

      expect(updated.status).toBe(ReviewStatus.PENDING);
      expect(updated.rating).toBe(5);
      expect(updated.title).toBe('New Title');
      expect(updated.version).toBe(2);
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('editing an approved review resets status to pending, subtracts rating from rollup, and emits outbox event', async () => {
      const { service, reviews, outbox, setProductRating, getProductRating } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.APPROVED,
          rating: 5,
          version: 1,
        }),
      );

      setProductRating(
        Object.assign(new ProductRatingEntity(), {
          productId: PRODUCT_ID,
          ratingSum: 15,
          ratingCount: 3,
          version: 3,
        }),
      );

      const updated = await service.update(REVIEW_ID, CUSTOMER_ID, {
        rating: 4,
      });

      expect(updated.status).toBe(ReviewStatus.PENDING);
      expect(updated.rating).toBe(4);
      expect(updated.version).toBe(2);

      // Rollup decremented: sum 15 - 5 = 10, count 3 - 1 = 2
      const rating = getProductRating();
      expect(rating?.ratingSum).toBe(10);
      expect(rating?.ratingCount).toBe(2);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'product.rating_changed',
          aggregateId: PRODUCT_ID,
          payload: {
            productId: PRODUCT_ID,
            ratingSum: 10,
            ratingCount: 2,
            ratingAvgE2: 500, // 10 / 2 = 5.00 -> 500
            version: 4,
          },
        }),
      );
    });
  });

  describe('moderate() transitions', () => {
    it('legal: pending -> approved increments rollup and emits product.rating_changed', async () => {
      const { service, reviews, outbox, getProductRating } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.PENDING,
          rating: 5,
          version: 1,
        }),
      );

      const approved = await service.moderate(REVIEW_ID, 'approve');

      expect(approved.status).toBe(ReviewStatus.APPROVED);
      const rating = getProductRating();
      expect(rating?.ratingSum).toBe(5);
      expect(rating?.ratingCount).toBe(1);

      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'product.rating_changed',
          aggregateId: PRODUCT_ID,
          payload: {
            productId: PRODUCT_ID,
            ratingSum: 5,
            ratingCount: 1,
            ratingAvgE2: 500,
            version: 1,
          },
        }),
      );
    });

    it('legal: pending -> rejected marks rejected without modifying rollup or emitting outbox event', async () => {
      const { service, reviews, outbox, getProductRating } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.PENDING,
          rating: 4,
          version: 1,
        }),
      );

      const rejected = await service.moderate(REVIEW_ID, 'reject', 'Spam review');

      expect(rejected.status).toBe(ReviewStatus.REJECTED);
      expect(rejected.moderationNote).toBe('Spam review');
      expect(getProductRating()).toBeNull();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('legal: approved -> rejected decrements rollup and emits product.rating_changed', async () => {
      const { service, reviews, outbox, setProductRating, getProductRating } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.APPROVED,
          rating: 4,
          version: 1,
        }),
      );

      setProductRating(
        Object.assign(new ProductRatingEntity(), {
          productId: PRODUCT_ID,
          ratingSum: 14,
          ratingCount: 3,
          version: 1,
        }),
      );

      const rejected = await service.moderate(REVIEW_ID, 'reject');

      expect(rejected.status).toBe(ReviewStatus.REJECTED);
      const rating = getProductRating();
      expect(rating?.ratingSum).toBe(10);
      expect(rating?.ratingCount).toBe(2);

      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'product.rating_changed',
          aggregateId: PRODUCT_ID,
          payload: {
            productId: PRODUCT_ID,
            ratingSum: 10,
            ratingCount: 2,
            ratingAvgE2: 500,
            version: 2,
          },
        }),
      );
    });

    it('legal: rejected -> approved increments rollup and emits product.rating_changed', async () => {
      const { service, reviews, outbox, getProductRating } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.REJECTED,
          rating: 5,
          version: 2,
        }),
      );

      const approved = await service.moderate(REVIEW_ID, 'approve');

      expect(approved.status).toBe(ReviewStatus.APPROVED);
      const rating = getProductRating();
      expect(rating?.ratingSum).toBe(5);
      expect(rating?.ratingCount).toBe(1);
      expect(outbox.append).toHaveBeenCalledTimes(1);
    });

    it('illegal: approved -> approved throws 409 ConflictException', async () => {
      const { service, reviews } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.APPROVED,
          rating: 5,
          version: 2,
        }),
      );

      await expect(service.moderate(REVIEW_ID, 'approve')).rejects.toThrow(ConflictException);
    });

    it('illegal: rejected -> rejected throws 409 ConflictException', async () => {
      const { service, reviews } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.REJECTED,
          rating: 2,
          version: 2,
        }),
      );

      await expect(service.moderate(REVIEW_ID, 'reject')).rejects.toThrow(ConflictException);
    });

    it('illegal: non-existent review throws 404 NotFoundException', async () => {
      const { service } = setup();
      await expect(service.moderate('missing-id', 'approve')).rejects.toThrow(NotFoundException);
    });
  });

  describe('eligibility()', () => {
    it('returns canReview: false if already reviewed', async () => {
      const { service, reviews } = setup();

      reviews.push(
        Object.assign(new ReviewEntity(), {
          id: REVIEW_ID,
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          status: ReviewStatus.PENDING,
        }),
      );

      const result = await service.eligibility(CUSTOMER_ID, PRODUCT_ID);
      expect(result.canReview).toBe(false);
      expect(result.existingReviewId).toBe(REVIEW_ID);
    });

    it('returns canReview: false if not purchased', async () => {
      const { service } = setup();

      const result = await service.eligibility(CUSTOMER_ID, PRODUCT_ID);
      expect(result.canReview).toBe(false);
      expect(result.reason).toContain('Only customers who bought');
    });

    it('returns canReview: true if purchased and no prior review exists', async () => {
      const { service, purchases } = setup();

      purchases.push(
        Object.assign(new PurchaseEntity(), {
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          orderId: ORDER_ID,
        }),
      );

      const result = await service.eligibility(CUSTOMER_ID, PRODUCT_ID);
      expect(result.canReview).toBe(true);
      expect(result.existingReviewId).toBeNull();
    });
  });
});
