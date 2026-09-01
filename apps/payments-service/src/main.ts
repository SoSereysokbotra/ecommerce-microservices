import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter, createValidationPipe, validateEnv } from '@libs/common';
import * as express from 'express';
import { AppModule } from './app.module';

const WEBHOOK_PATH = '/api/v1/payments/webhook';

async function bootstrap(): Promise<void> {
  validateEnv('payments-service', {
    always: ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    productionOnly: ['RABBITMQ_URL'],
  });

  // bodyParser: false so the webhook route can keep the exact bytes Stripe
  // signed. The parsers below are then registered by hand, in order.
  const app = await NestFactory.create(AppModule, { cors: true, bodyParser: false });

  // Raw body FIRST, and only for the webhook path. Stripe signs the literal
  // request body; parsing it to an object and re-serialising changes the bytes
  // and the signature no longer verifies. This is the single most common way
  // Stripe webhook integrations break.
  app.use(
    WEBHOOK_PATH,
    express.raw({ type: 'application/json' }),
    (
      req: express.Request & { rawBody?: Buffer },
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
      }
      next();
    },
  );

  // Every other route gets normal JSON parsing.
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.enableCors({
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id', 'stripe-signature'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Payments Service')
    .setDescription('Stripe payment intents, webhooks and refunds')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup('api/v1/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(Number(process.env.PORT ?? 3005));
}

void bootstrap();
