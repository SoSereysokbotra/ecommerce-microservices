import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min, MinLength } from 'class-validator';
import { ReviewStatus } from '../review.entity';

export class CreateReviewDto {
  /**
   * Rating scale is strictly integer 1–5 (M13_REVIEWS_PLAN.md §2).
   * Half stars are a presentation layer choice, not stored state.
   */
  @ApiProperty({ example: 5, minimum: 1, maximum: 5, description: 'Star rating 1–5 integer.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ example: 'Great fit and feel', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  title: string;

  @ApiProperty({ example: 'Comfortable material and true to size.' })
  @IsString()
  @MinLength(1)
  body: string;
}

export class UpdateReviewDto {
  @ApiPropertyOptional({ example: 4, minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ example: 'Updated title', maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  title?: string;

  @ApiPropertyOptional({ example: 'Updated review content.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  body?: string;
}

export class ModerateDto {
  @ApiPropertyOptional({
    example: 'Content adheres to community guidelines',
    description: 'Optional internal moderation note.',
  })
  @IsOptional()
  @IsString()
  moderationNote?: string;
}

export class ListReviewsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class ListModerationQueryDto {
  @ApiPropertyOptional({
    enum: ReviewStatus,
    default: ReviewStatus.PENDING,
    description: 'Filter reviews by moderation status.',
  })
  @IsOptional()
  @IsEnum(ReviewStatus)
  status?: ReviewStatus = ReviewStatus.PENDING;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/**
 * A review as the **public** list returns it.
 *
 * Deliberately not `ReviewResponseDto`. `GET /reviews/products/:id` needs no
 * token, so everything on it is world-readable: shipping a `customerId` and
 * an `orderId` there would publish, for every review on the site, which
 * account wrote it and which order it came from. A display name is what a
 * review shows; the ids are bookkeeping.
 *
 * `status` is absent for the same reason — the list is approved-only, so the
 * field would always read "approved" and only ever leak that other states
 * exist.
 *
 * **This was lost once already.** It was added in M13 step 3 and silently
 * reverted by step 5 when this file was rewritten; the public endpoint leaked
 * both ids again until step 6 caught it. If you are regenerating this file,
 * keep this type.
 */
export class PublicReviewDto {
  @ApiProperty() id: string;
  @ApiProperty() productId: string;
  @ApiProperty({ example: 5 }) rating: number;
  @ApiProperty() title: string;
  @ApiProperty() body: string;
  @ApiProperty({ example: 'Alex M.' }) authorName: string;
  @ApiProperty() createdAt: Date;
}

/**
 * The product's rating, as its owner holds it.
 *
 * reviews-service keeps `product_ratings` and is the only thing entitled to
 * say what a product's average is. It travels on the list response so a
 * client never has to derive it — a storefront averaging the page it happens
 * to be showing gets a different number on page 2, and two implementations of
 * one figure is the defect M8 removed from pricing (ADR-0007).
 *
 * Null when the product has no approved review. Zero would be a rating.
 */
export class ProductRatingDto {
  @ApiProperty({ example: 437, description: 'Average × 100. 437 = 4.37.' })
  avgE2: number;

  @ApiProperty({ example: 12, description: 'Approved reviews counted.' })
  count: number;
}

export class ReviewResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' })
  productId: string;

  @ApiProperty({ example: 'c3d4e5f6-a7b8-9012-cdef-123456789012' })
  customerId: string;

  @ApiProperty({ example: 'd4e5f6a7-b8c9-0123-def1-234567890123' })
  orderId: string;

  @ApiProperty({ example: 5 })
  rating: number;

  @ApiProperty({ example: 'Great fit and feel' })
  title: string;

  @ApiProperty({ example: 'Comfortable material and true to size.' })
  body: string;

  @ApiProperty({ example: 'Alex Doe' })
  authorName: string;

  @ApiProperty({ enum: ReviewStatus, example: ReviewStatus.APPROVED })
  status: ReviewStatus;

  @ApiPropertyOptional({ nullable: true })
  moderatedAt?: Date | null;

  @ApiPropertyOptional({ nullable: true })
  moderationNote?: string | null;

  @ApiProperty({ example: 1 })
  version: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class PaginatedReviewsResponseDto {
  @ApiProperty({ type: [PublicReviewDto] })
  items: PublicReviewDto[];

  @ApiProperty({
    type: ProductRatingDto,
    nullable: true,
    description: "The whole product's rating, not this page's. Null when unrated.",
  })
  rating: ProductRatingDto | null;

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;
}

/**
 * The moderation queue's page.
 *
 * Separate from `PaginatedReviewsResponseDto` on purpose. This one is behind
 * a token and a moderator needs the whole review — including `customerId`,
 * which the public list must never carry — and has no use for the product's
 * average.
 */
export class PaginatedModerationResponseDto {
  @ApiProperty({ type: [ReviewResponseDto] })
  items: ReviewResponseDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;
}

export class EligibilityResponseDto {
  @ApiProperty({
    example: true,
    description:
      'True if customer has confirmed purchases and no existing review for this product.',
  })
  canReview: boolean;

  @ApiProperty({ example: 'Eligible to review' })
  reason: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    nullable: true,
    description: 'Existing review ID if customer already reviewed this product.',
  })
  existingReviewId?: string | null;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    nullable: true,
    description: 'Alias for existingReviewId.',
  })
  existing?: string | null;
}
