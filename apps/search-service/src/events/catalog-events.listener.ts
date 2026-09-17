import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { isProductEventPayload, toProductDocument } from '../modules/search/product-document';
import { ProductsProjection } from '../modules/search/products.projection';

/**
 * The read side of CQRS: catalog's events in, index documents out.
 *
 * Compare this with `ShippingEventsListener` in shipping-service, which is
 * the same shape minus two things: there is no `IdempotencyService` and no
 * transaction, because there is no database. The version on the event and
 * `version_type: external` in `ProductsProjection` do the whole job — see
 * that class for the table of what they refuse.
 *
 * `product.created` and `product.updated` are handled identically. Both carry
 * full state, so both are an upsert; the name records what happened on the
 * write side and is irrelevant here.
 *
 * `category.*` is received (the queue binds it since step 2) and ignored
 * until step 6, where a rename fans out to every product in the category.
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
}
