import { BaseEvent } from './base.event';

export class UserCreatedEvent extends BaseEvent {
  constructor(
    public readonly userId: string,
    public readonly email: string,
    public readonly name: string,
  ) {
    super();
  }
}

export class UserUpdatedEvent extends BaseEvent {
  constructor(
    public readonly userId: string,
    public readonly changes: Record<string, unknown>,
  ) {
    super();
  }
}

export class UserDeletedEvent extends BaseEvent {
  constructor(public readonly userId: string) {
    super();
  }
}
