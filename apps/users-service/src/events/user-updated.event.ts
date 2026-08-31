import { BaseEvent } from '@libs/rabbitmq';

export class UserUpdatedDomainEvent extends BaseEvent {
  constructor(
    public readonly userId: string,
    public readonly changes: Record<string, unknown>,
  ) {
    super();
  }
}
