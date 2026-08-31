import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter, createValidationPipe } from '@libs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // No secrets to validate yet — the M2 stub has no provider keys and no
  // database. M4 adds STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET here.
  const app = await NestFactory.create(AppModule, { cors: true });

  app.enableCors({
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Payments Service')
    .setDescription('Payment stub — replaced by Stripe in M4')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup('api/v1/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(Number(process.env.PORT ?? 3005));
}

void bootstrap();
