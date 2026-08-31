import { BadRequestException, ValidationPipe as NestValidationPipe } from '@nestjs/common';

export const createValidationPipe = (): NestValidationPipe =>
  new NestValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
    exceptionFactory: (errors) => {
      const messages = errors.map((error) => {
        const constraints = error.constraints
          ? Object.values(error.constraints).join(', ')
          : 'Validation failed';
        return `${error.property}: ${constraints}`;
      });
      return new BadRequestException({
        statusCode: 400,
        message: messages,
        error: 'Validation Error',
      });
    },
  });
