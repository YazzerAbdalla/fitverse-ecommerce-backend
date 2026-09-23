import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 1. Retrieve the ConfigService instance from the app context
  const configService = app.get(ConfigService);
  const rabbitmqUrl = configService.get<string>('RABBITMQ_URL');
  const queueName = configService.get<string>(
    'RABBITMQ_QUEUE',
    'notification_queue',
  );

  // 2. Connect the microservice using variables
  // noAck=false for manual ACK after verification processing (Correction 3)
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl!],
      queue: queueName,
      queueOptions: {
        durable: true,
      },
      noAck: false,
      prefetchCount: 10,
    },
  });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip undefined properties
      forbidNonWhitelisted: true, // Reject requests with unexpected fields
      transform: true, // Auto-convert payloads to DTO instances
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.startAllMicroservices();

  const config = new DocumentBuilder()
    .setTitle('Mini e-commerce')
    .setDescription('First system design mini project')
    .setVersion('1.0')
    .addTag('Api')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token',
      },
      'JWT-auth', // Security scheme name
    )
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  // CORS Configuration

  app.enableCors({
    origin: true,
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `Application is running on: http://localhost:${process.env.PORT ?? 3000}`,
  );
}
bootstrap();
