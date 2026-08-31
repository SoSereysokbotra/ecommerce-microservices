import { SetMetadata } from '@nestjs/common';

export const MESSAGE_HANDLER_KEY = 'message_handler_key';

export const MessageHandler = (routingKey: string): MethodDecorator =>
  SetMetadata(MESSAGE_HANDLER_KEY, routingKey);
