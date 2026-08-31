import { BaseEvent } from '@libs/rabbitmq';

export class UserCreatedDomainEvent extends BaseEvent {
  constructor(
    public readonly userId: string,
    public readonly email: string,
    public readonly name: string,
  ) {
    super();
  }
}
