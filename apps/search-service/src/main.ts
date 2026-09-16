import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter, createValidationPipe, validateEnv } from '@libs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // OPENSEARCH_URL, not DATABASE_URL: this is the one service with no
  // relational store. See app.module.ts.
  validateEnv('search-service', {
    always: ['OPENSEARCH_URL'],
  });

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
    .setTitle('Search Service')
    .setDescription('Product search over an OpenSearch read model built from catalog events')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document);

  const port = Number(process.env.PORT ?? 3009);
  await app.listen(port);
}

void bootstrap();
