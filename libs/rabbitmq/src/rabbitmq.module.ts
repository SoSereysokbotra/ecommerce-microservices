import { DynamicModule, Global, Module } from '@nestjs/common';
import { RabbitMQService, RabbitMQModuleOptions } from './rabbitmq.service';

export const RABBITMQ_OPTIONS = 'RABBITMQ_OPTIONS';

@Global()
@Module({})
export class RabbitMQModule {
  static forRoot(options: RabbitMQModuleOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      providers: [
        { provide: RABBITMQ_OPTIONS, useValue: options },
        {
          provide: RabbitMQService,
          useFactory: (opts: RabbitMQModuleOptions) => new RabbitMQService(opts),
          inject: [RABBITMQ_OPTIONS],
        },
      ],
      exports: [RabbitMQService],
    };
  }
}
