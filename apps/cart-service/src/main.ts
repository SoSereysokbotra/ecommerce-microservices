import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter, createValidationPipe, validateEnv } from '@libs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  validateEnv('cart-service', {
    always: ['DATABASE_URL'],
    productionOnly: ['RABBITMQ_URL', 'REDIS_URL'],
  });

  const app = await NestFactory.create(AppModule, { cors: true });

  app.enableCors({
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    // x-cart-token identifies a guest cart. It is a header rather than a cookie
    // because the storefront and gateway sit on different origins, which would
    // make a cookie third-party — see docs/M7_CART_PLAN.md §3.
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id', 'x-cart-token'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Cart Service')
    .setDescription('Guest and signed-in carts, merged on login')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document);

  const port = Number(process.env.PORT ?? 3006);
  await app.listen(port);
}

void bootstrap();
