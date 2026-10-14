import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter, createValidationPipe, validateEnv } from '@libs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  validateEnv('users-service', {
    always: ['JWT_SECRET', 'DATABASE_URL'],
    productionOnly: ['RABBITMQ_URL'],
  });

  const app = await NestFactory.create(AppModule, { cors: true });

  app.use(cookieParser());

  app.enableCors({
    origin: ['http://localhost:3011', 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id', 'traceparent'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Users Service')
    .setDescription('Authentication and customer accounts')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
