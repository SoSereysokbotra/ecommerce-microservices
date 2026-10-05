import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { ReviewEntity, ReviewStatus } from './review.entity';
import { ProductRatingEntity } from './product-rating.entity';
import { PurchasesService } from './purchases.service';
import { UsersClient } from './users.client';
import { ratingAvgE2 } from './rating-rollup';
import {
  CreateReviewDto,
  EligibilityResponseDto,
  ListModerationQueryDto,
  ListReviewsQueryDto,
  ProductRatingDto,
  PublicReviewDto,
  UpdateReviewDto,
} from './dto/review.dto';

/** Strips the bookkeeping ids a world-readable list must not carry. */
function toPublicReview(review: ReviewEntity): PublicReviewDto {
  return {
    id: review.id,
    productId: review.productId,
    rating: review.rating,
    title: review.title,
    body: review.body,
    authorName: review.authorName,
    createdAt: review.createdAt,
  };
}

/**
 * Rows from a `... RETURNING` clause, whatever statement produced them.
 *
 * Copied from M9's coupons.service.ts (HANDOFF §5). TypeORM's query() returns
 * different shapes across Postgres statement types:
 *   - UPDATE ... RETURNING -> [[{ rows }], count]
 *   - INSERT ... RETURNING -> [{ rows }]
 *   - SELECT               -> [{ rows }]
 */
function returning<T = Record<string, unknown>>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
}

/**
 * A `product_ratings` row as raw SQL returns it.
 *
 * **Raw rows are snake_case.** `manager.query()` hands back the database's own
 * column names, not the entity's properties — TypeORM only maps when it builds
 * the entity itself. Reading `row.ratingSum` off one of these yields
 * `undefined`, which then reaches `ratingAvgE2` as `NaN` and throws inside
 * `BigInt()`. That is not theoretical: the first version of this file did it
 * at three call sites and every approval would have 500'd in production, while
 * the unit tests passed because they mock `query`. Same family as the
 * INSERT-vs-UPDATE shape trap in HANDOFF §5 — a raw query's result is not an
 * entity, and the type parameter is a claim, not a conversion.
 */
interface RawRatingRow {
  product_id: string;
  rating_sum: string | number;
  rating_count: string | number;
  version: string | number;
}

/**
 * A `reviews` row from `RETURNING reviews.*`, plus the previous status the
 * moderation CTE captures. Snake_case for the same reason as above: the
 * `ReviewEntity` type parameter this once carried was a claim the data did
 * not honour, and `row.productId` was silently undefined.
 */
interface RawReviewRow {
  id: string;
  product_id: string;
  customer_id: string;
  rating: string | number;
  status: string;
  prev_status: string;
}

/** The mapped shape everything downstream uses. Integers, always. */
export interface RatingRollup {
  productId: string;
  ratingSum: number;
  ratingCount: number;
  version: number;
}

function toRollup(row: RawRatingRow): RatingRollup {
  return {
    productId: row.product_id,
    ratingSum: Number(row.rating_sum),
    ratingCount: Number(row.rating_count),
    version: Number(row.version),
  };
}

/**
 * Lifecycle and state machine for reviews, and custodian of the rating rollup.
 *
 * ## The two core design rules (M13_REVIEWS_PLAN.md §1, §4, §5)
 *
 * 1. **Verified purchase is an event-derived authorisation**:
 *    The right to review is not a role and not an admin grant — it is a fact
 *    about the past that arrived on the bus (`order.confirmed` -> `purchases`).
 *    `create()` refuses anyone with no purchase row with 403 Forbidden.
 *
 * 2. **Rollup moves in the moderation transaction**:
 *    search-service has no database and cannot compute an average. So the write
 *    side maintains `product_ratings` (sum, count, version) and emits
 *    `product.rating_changed` in the same transaction as the status change.
 *    Only `approved` reviews are counted; an edit of an approved review moves it
 *    back to `pending` and immediately subtracts from the rollup.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ReviewEntity)
    private readonly reviewsRepository: Repository<ReviewEntity>,
    @InjectRepository(ProductRatingEntity)
    private readonly ratingsRepository: Repository<ProductRatingEntity>,
    private readonly purchasesService: PurchasesService,
    private readonly usersClient: UsersClient,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Create a new review for a product.
   *
   *   - 403 Forbidden if customer has not purchased this product.
   *   - 409 Conflict if customer already reviewed it (one review per product).
   *   - Snapshots author_name from users-service (503 if unreachable).
   *   - Status starts as PENDING. Rollup is untouched until approved.
   */
  async create(
    customerId: string,
    productId: string,
    dto: CreateReviewDto,
    correlationId?: string,
  ): Promise<ReviewEntity> {
    const purchase = await this.purchasesService.hasPurchased(
      this.dataSource.manager,
      customerId,
      productId,
    );

    if (!purchase) {
      throw new ForbiddenException('Only customers who bought this product can review it');
    }

    const existing = await this.reviewsRepository.findOne({
      where: { productId, customerId },
    });

    if (existing) {
      throw new ConflictException('You have already reviewed this product; use PATCH to edit it');
    }

    // Read author name server-side to snapshot provenance. 503 if users-service is down.
    const user = await this.usersClient.getUser(customerId, correlationId);

    const review = this.reviewsRepository.create({
      productId,
      customerId,
      orderId: purchase.orderId,
      rating: dto.rating,
      title: dto.title.trim(),
      body: dto.body.trim(),
      authorName: user.name,
      status: ReviewStatus.PENDING,
      version: 1,
    });

    const saved = await this.reviewsRepository.save(review);
    this.logger.log(
      `Created pending review ${saved.id} for product ${productId} by customer ${customerId}`,
    );
    return saved;
  }

  /**
   * Edit a review. Owner only.
   *
   * An edit is a new submission:
   *   - Status returns to PENDING.
   *   - If previously APPROVED, its rating is subtracted from product_ratings
   *     and `product.rating_changed` is emitted in the same transaction.
   */
  async update(id: string, customerId: string, dto: UpdateReviewDto): Promise<ReviewEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const review = await manager.findOne(ReviewEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!review) {
        throw new NotFoundException(`Review '${id}' not found`);
      }

      if (review.customerId !== customerId) {
        throw new ForbiddenException('You cannot edit another customer review');
      }

      const wasApproved = review.status === ReviewStatus.APPROVED;

      if (wasApproved) {
        // The old rating leaves the average while the edit awaits
        // re-moderation. `review` here came from findOne, so it is a real
        // entity and its properties are camelCase.
        await this.applyRatingDelta(manager, review.productId, review.rating, 'subtract');
      }

      if (dto.rating !== undefined) review.rating = dto.rating;
      if (dto.title !== undefined) review.title = dto.title.trim();
      if (dto.body !== undefined) review.body = dto.body.trim();

      review.status = ReviewStatus.PENDING;
      review.moderatedAt = null;
      review.moderationNote = null;
      review.version += 1;

      const saved = await manager.save(ReviewEntity, review);
      this.logger.log(`Review ${id} edited; status reset to pending (wasApproved: ${wasApproved})`);
      return saved;
    });
  }

  /**
   * Moderation transition: approve or reject.
   *
   *   - Conditional UPDATE on status: zero rows affected -> 409 Conflict.
   *   - Updates product_ratings and appends product.rating_changed in ONE transaction.
   */
  async moderate(
    id: string,
    action: 'approve' | 'reject',
    moderationNote?: string,
  ): Promise<ReviewEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const allowedStatuses =
        action === 'approve'
          ? [ReviewStatus.PENDING, ReviewStatus.REJECTED]
          : [ReviewStatus.PENDING, ReviewStatus.APPROVED];

      const targetStatus = action === 'approve' ? ReviewStatus.APPROVED : ReviewStatus.REJECTED;

      // Conditional UPDATE with status guard and CTE to capture previous status
      const updatedRows = returning<RawReviewRow>(
        await manager.query(
          `WITH prev AS (
             SELECT status AS prev_status FROM reviews WHERE id = $3 AND status = ANY($4) FOR UPDATE
           )
           UPDATE reviews
           SET status = $1,
               version = version + 1,
               moderated_at = now(),
               moderation_note = $2,
               updated_at = now()
           WHERE id = $3 AND status = ANY($4)
           RETURNING reviews.*, (SELECT prev_status FROM prev) AS prev_status`,
          [targetStatus, moderationNote ?? null, id, allowedStatuses],
        ),
      );

      if (updatedRows.length === 0) {
        const existing = await manager.findOne(ReviewEntity, { where: { id } });
        if (!existing) {
          throw new NotFoundException(`Review '${id}' not found`);
        }
        throw new ConflictException(
          `Cannot ${action} review '${id}' with status '${existing.status}'`,
        );
      }

      // Raw row: snake_case, not entity properties. See RawRatingRow above.
      const row = updatedRows[0];
      const prevStatus = row.prev_status as ReviewStatus;
      const productId = row.product_id;
      const rating = Number(row.rating);

      if (action === 'approve') {
        // pending or rejected -> approved: the rating joins the average.
        await this.applyRatingDelta(manager, productId, rating, 'add');
      } else if (action === 'reject' && prevStatus === ReviewStatus.APPROVED) {
        // approved -> rejected: it leaves again.
        await this.applyRatingDelta(manager, productId, rating, 'subtract');
      }

      this.logger.log(`Review ${id} moderated: ${prevStatus} -> ${targetStatus}`);
      // Re-read as an entity: `row` is a raw snake_case record and would
      // serialise with the wrong field names.
      return manager.findOneByOrFail(ReviewEntity, { id });
    });
  }

  /**
   * Moves the rollup by one review and announces the result — the only place
   * `product_ratings` is written and the only place `product.rating_changed`
   * is produced.
   *
   * One method rather than the three near-identical blocks this started as:
   * approve adds a rating, reject and edit-of-an-approved subtract one, and
   * the arithmetic, the mapping and the event are identical in all three. A
   * bug fixed in one copy is a bug left in two.
   *
   * `GREATEST(0, …)` on the subtract is a floor, not a correctness mechanism —
   * `CHK_product_ratings_nonneg` is what makes a negative impossible. The
   * floor means a drifted row degrades to zero rather than aborting a
   * moderator's legitimate rejection.
   *
   * Returns null when subtracting from a product that has no rollup row yet,
   * which can only happen if a review was approved before this service owned
   * the rollup. Nothing to announce.
   */
  private async applyRatingDelta(
    manager: EntityManager,
    productId: string,
    rating: number,
    direction: 'add' | 'subtract',
  ): Promise<RatingRollup | null> {
    const rows =
      direction === 'add'
        ? returning<RawRatingRow>(
            await manager.query(
              `INSERT INTO product_ratings (product_id, rating_sum, rating_count, version, updated_at)
               VALUES ($1, $2, 1, 1, now())
               ON CONFLICT (product_id) DO UPDATE
               SET rating_sum = product_ratings.rating_sum + EXCLUDED.rating_sum,
                   rating_count = product_ratings.rating_count + 1,
                   version = product_ratings.version + 1,
                   updated_at = now()
               RETURNING *`,
              [productId, rating],
            ),
          )
        : returning<RawRatingRow>(
            await manager.query(
              `UPDATE product_ratings
               SET rating_sum = GREATEST(0, rating_sum - $1),
                   rating_count = GREATEST(0, rating_count - 1),
                   version = version + 1,
                   updated_at = now()
               WHERE product_id = $2
               RETURNING *`,
              [rating, productId],
            ),
          );

    if (rows.length === 0) {
      return null;
    }

    const rollup = toRollup(rows[0]);

    await this.outbox.append(manager, {
      eventType: 'product.rating_changed',
      aggregateId: rollup.productId,
      payload: {
        productId: rollup.productId,
        ratingSum: rollup.ratingSum,
        ratingCount: rollup.ratingCount,
        // Derived here, never stored. See rating-rollup.ts.
        ratingAvgE2: ratingAvgE2(rollup.ratingSum, rollup.ratingCount),
        version: rollup.version,
      },
      // The rollup's own clock — a third version on the search document,
      // beside the product's and the category's (M13_REVIEWS_PLAN.md §4).
      version: rollup.version,
    });

    return rollup;
  }

  /** Public list for a product: approved only, newest first, paginated. */
  async listForProduct(
    productId: string,
    query: ListReviewsQueryDto,
  ): Promise<{
    items: PublicReviewDto[];
    rating: ProductRatingDto | null;
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const [[items, total], rollup] = await Promise.all([
      this.reviewsRepository.findAndCount({
        where: { productId, status: ReviewStatus.APPROVED },
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      }),
      this.ratingsRepository.findOne({ where: { productId } }),
    ]);

    // The average travels with the list, read from the row that owns it.
    // A client cannot derive it: this page holds ten reviews and the product
    // may have ninety, so averaging what was sent gives a different number on
    // every page. One owner per figure — the M8 rule (ADR-0007).
    const rating =
      rollup && rollup.ratingCount > 0
        ? {
            avgE2: ratingAvgE2(Number(rollup.ratingSum), Number(rollup.ratingCount)),
            count: Number(rollup.ratingCount),
          }
        : null;

    // Mapped, not returned raw: this endpoint needs no token, so the entity's
    // `customerId` and `orderId` would be world-readable. See PublicReviewDto.
    return { items: items.map(toPublicReview), rating, total, page, limit };
  }

  /** Authenticated customer: all reviews authored by customer. */
  async listForCustomer(customerId: string): Promise<ReviewEntity[]> {
    return this.reviewsRepository.find({
      where: { customerId },
      order: { createdAt: 'DESC' },
    });
  }

  /** Staff: list reviews for moderation queue. */
  async listForModeration(
    query: ListModerationQueryDto,
  ): Promise<{ items: ReviewEntity[]; total: number; page: number; limit: number }> {
    const status = query.status ?? ReviewStatus.PENDING;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [items, total] = await this.reviewsRepository.findAndCount({
      where: { status },
      order: { createdAt: 'ASC' },
      skip,
      take: limit,
    });

    return { items, total, page, limit };
  }

  /** Eligibility check: can this customer review this product? */
  async eligibility(customerId: string, productId: string): Promise<EligibilityResponseDto> {
    const existing = await this.reviewsRepository.findOne({
      where: { customerId, productId },
    });

    if (existing) {
      return {
        canReview: false,
        reason: 'You have already reviewed this product',
        existingReviewId: existing.id,
        existing: existing.id,
      };
    }

    const purchase = await this.purchasesService.hasPurchased(
      this.dataSource.manager,
      customerId,
      productId,
    );

    if (!purchase) {
      return {
        canReview: false,
        reason: 'Only customers who bought this product can review it',
        existingReviewId: null,
        existing: null,
      };
    }

    return {
      canReview: true,
      reason: 'Eligible to review',
      existingReviewId: null,
      existing: null,
    };
  }

  /**
   * Replay write-side rating events for search-service index rebuild.
   * The write side owns replay (M13_REVIEWS_PLAN.md §5, §6).
   */
  async republish(): Promise<{ ratings: number }> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const allRatings = await manager.find(ProductRatingEntity, {
        order: { productId: 'ASC' },
      });

      for (const r of allRatings) {
        const avgE2 = ratingAvgE2(Number(r.ratingSum), Number(r.ratingCount));
        await this.outbox.append(manager, {
          eventType: 'product.rating_changed',
          aggregateId: r.productId,
          payload: {
            productId: r.productId,
            ratingSum: Number(r.ratingSum),
            ratingCount: Number(r.ratingCount),
            ratingAvgE2: avgE2,
            version: Number(r.version),
          },
          version: Number(r.version),
        });
      }

      this.logger.log(`Republished ${allRatings.length} product rating events`);
      return { ratings: allRatings.length };
    });
  }
}
