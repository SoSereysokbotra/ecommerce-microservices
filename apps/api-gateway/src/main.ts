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
  const app = await NestFactory.create(AppModule, { cors: true, bodyParser: false });

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
      urls: [
        { name: 'Gateway', url: 'http://localhost:3000/api/v1/docs-json' },
        { name: 'Users', url: 'http://localhost:3001/api/v1/docs-json' },
      ],
    },
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
