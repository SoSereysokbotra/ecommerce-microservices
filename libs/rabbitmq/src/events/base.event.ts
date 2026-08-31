export abstract class BaseEvent {
  timestamp: Date = new Date();

  correlationId?: string;

  constructor(partial: Partial<BaseEvent> = {}) {
    Object.assign(this, partial);
  }
}
