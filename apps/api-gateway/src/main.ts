import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter, createValidationPipe, validateEnv } from '@libs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Refuse to start rather than boot with a forgeable token secret.
  validateEnv('api-gateway', { always: ['JWT_SECRET'] });

  const app = await NestFactory.create(AppModule, { cors: true });

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
