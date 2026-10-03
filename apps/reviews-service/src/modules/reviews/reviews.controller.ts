import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, Public, USER_ID_HEADER } from '@libs/common';
import { ReviewsService } from './reviews.service';
import {
  CreateReviewDto,
  EligibilityResponseDto,
  ListReviewsQueryDto,
  PaginatedReviewsResponseDto,
  ReviewResponseDto,
  UpdateReviewDto,
} from './dto/review.dto';

/**
 * Public and authenticated review operations.
 *
 * Routes follow docs/M13_REVIEWS_PLAN.md §6.
 */
@ApiTags('reviews')
@ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Browsing reviews for a product is public; only approved reviews return. */
  @Public()
  @Get('products/:productId')
  @ApiOperation({ summary: 'List approved reviews for a product (public, newest first)' })
  @ApiOkResponse({ type: PaginatedReviewsResponseDto })
  listForProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: ListReviewsQueryDto,
  ): Promise<PaginatedReviewsResponseDto> {
    return this.reviews.listForProduct(productId, query);
  }

  /** Checks if the signed-in customer is eligible to review the given product. */
  @Get('products/:productId/eligibility')
  @ApiOperation({ summary: 'Check if current customer can review this product' })
  @ApiOkResponse({ type: EligibilityResponseDto })
  eligibility(
    @Headers(USER_ID_HEADER) customerId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<EligibilityResponseDto> {
    return this.reviews.eligibility(this.requireCustomer(customerId), productId);
  }

  /** Submit a review for a purchased product. Starts as PENDING. */
  @Post('products/:productId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a review for a purchased product' })
  @ApiOkResponse({ type: ReviewResponseDto })
  create(
    @Headers(USER_ID_HEADER) customerId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    return this.reviews.create(this.requireCustomer(customerId), productId, body, correlationId);
  }

  /** Edit an existing review. Owner only; returns status to PENDING. */
  @Patch(':id')
  @ApiOperation({ summary: 'Edit an existing review (owner only; resets status to pending)' })
  @ApiOkResponse({ type: ReviewResponseDto })
  update(
    @Headers(USER_ID_HEADER) customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReviewDto,
  ): Promise<ReviewResponseDto> {
    return this.reviews.update(id, this.requireCustomer(customerId), body);
  }

  /** List all reviews authored by the signed-in customer. */
  @Get('me')
  @ApiOperation({ summary: 'List my authored reviews' })
  @ApiOkResponse({ type: [ReviewResponseDto] })
  listMine(@Headers(USER_ID_HEADER) customerId: string): Promise<ReviewResponseDto[]> {
    return this.reviews.listForCustomer(this.requireCustomer(customerId));
  }

  private requireCustomer(customerId?: string): string {
    if (!customerId) {
      throw new BadRequestException(`Missing ${USER_ID_HEADER}; requests must go via the gateway`);
    }
    return customerId;
  }
}
