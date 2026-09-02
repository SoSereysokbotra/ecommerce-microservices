import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter, createValidationPipe, validateEnv } from '@libs/common';
import * as express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

const STRIPE_WEBHOOK_PATH = '/api/v1/payments/webhook';

async function bootstrap(): Promise<void> {
  // Refuse to start rather than boot with a forgeable token secret.
  validateEnv('api-gateway', { always: ['JWT_SECRET'] });

  // bodyParser: false so the Stripe webhook route can be forwarded byte for
  // byte. Stripe signs the raw request body; parsing it to an object here and
  // re-serialising it downstream changes the bytes and signature verification
  // fails in payments-service.
  // The storefront is the only browser origin in production. CORS_ORIGINS is a
  // comma-separated allowlist; leaving it unset keeps the permissive
  // development behaviour, so local work and Playwright are unaffected.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const app = await NestFactory.create(AppModule, {
    cors: corsOrigins.length > 0 ? { origin: corsOrigins, credentials: true } : true,
    bodyParser: false,
  });

  app.use(
    STRIPE_WEBHOOK_PATH,
    express.raw({ type: '*/*' }),
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
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Commerce API Gateway')
    .setDescription('Unified entry point for the commerce microservices')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document, {
    explorer: true,
    swaggerOptions: {
      // Relative, so the explorer works on whatever host serves it rather than
      // only on localhost. The per-service documents stay on the internal
      // network in production, so they are listed only when configured.
      urls: [
        { name: 'Gateway', url: '/api/v1/docs-json' },
        ...(process.env.USERS_DOCS_URL ? [{ name: 'Users', url: process.env.USERS_DOCS_URL }] : []),
      ],
    },
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
