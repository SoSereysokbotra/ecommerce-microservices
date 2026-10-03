import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { isProductEventPayload, toProductDocument } from '../modules/search/product-document';
import { isCategoryEventPayload } from '../modules/search/category-fanout';
import { ProductsProjection, isRatingEventPayload } from '../modules/search/products.projection';

/**
 * The read side of CQRS: catalog's and reviews' events in, index documents out.
 *
 * Compare this with `ShippingEventsListener` in shipping-service, which is
 * the same shape minus two things: there is no `IdempotencyService` and no
 * transaction, because there is no database. The version on each event and
 * scripted updates in `ProductsProjection` do the whole job (ADR-0011, M13 §5).
 *
 * `product.created` and `product.updated` are handled identically. Both carry
 * full state, so both are an upsert; the name records what happened on the
 * write side and is irrelevant here.
 *
 * `product.rating_changed` is reviews-service projecting its rollup onto the same
 * document. Handled by applyRating(), guarded by its own clock (ratingVersion),
 * leaving catalog's product fields alone (docs/M13_REVIEWS_PLAN.md §5 Option A).
 *
 * `category.updated` is the fan-out: the category's fields are denormalised
 * onto every product document, so a rename rewrites all of them in one
 * `_update_by_query`, guarded by `categoryVersion` (step 6). `category.created`
 * has nothing to fan out to — no product can be in a category that did not
 * exist a moment ago — and is treated the same way, which makes it a no-op.
 */
@Injectable()
export class CatalogEventsListener implements OnModuleInit {
  private readonly logger = new Logger(CatalogEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly projection: ProductsProjection,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'search-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.eventType === 'product.rating_changed') {
      return this.handleRating(event);
    }

    if (event.eventType === 'category.created' || event.eventType === 'category.updated') {
      return this.handleCategory(event);
    }

    if (event.eventType !== 'product.created' && event.eventType !== 'product.updated') {
      return;
    }

    if (!isProductEventPayload(event.payload)) {
      // No id or no version means no document and no guard. Dropping rather
      // than throwing: a redelivery would be just as unusable.
      this.logger.warn(`${event.eventType} (${event.eventId}) has an unusable payload; dropping`);
      return;
    }

    const doc = toProductDocument(event.payload);
    const outcome = await this.projection.upsert(doc);

    if (outcome === 'written') {
      this.logger.log(`Indexed product ${doc.id} v${doc.version} (${event.eventType})`);
    }
  }

  private async handleRating(event: DomainEvent): Promise<void> {
    if (!isRatingEventPayload(event.payload)) {
      this.logger.warn(`${event.eventType} (${event.eventId}) has an unusable payload; dropping`);
      return;
    }

    const outcome = await this.projection.applyRating(event.payload);
    if (outcome === 'written') {
      this.logger.log(
        `Updated rating for product ${event.payload.productId} v${event.payload.version} ` +
          `(${event.payload.ratingCount} reviews, avg ${(event.payload.ratingAvgE2 / 100).toFixed(2)})`,
      );
    }
  }

  private async handleCategory(event: DomainEvent): Promise<void> {
    if (!isCategoryEventPayload(event.payload)) {
      this.logger.warn(`${event.eventType} (${event.eventId}) has an unusable payload; dropping`);
      return;
    }

    const outcome = await this.projection.fanoutCategory(event.payload);
    if (outcome.matched > 0) {
      this.logger.log(
        `Category ${event.payload.id} v${event.payload.version} "${event.payload.name}" ` +
          `fanned out to ${outcome.updated} of ${outcome.matched} products`,
      );
    }
  }
}
