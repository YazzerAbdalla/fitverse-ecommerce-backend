import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';

/**
 * This module exposes the RabbitMQ notification client application-wide.
 * It handles single registration of the NOTIFICATION_SERVICE ClientProxy so
 * feature modules (outbox, auth) can @Inject it without importing ClientsModule
 * themselves (Nest DI scoping made the previous AppModule-local registration
 * invisible to them, resolving to undefined via @Optional()).
 */
@Global()
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'NOTIFICATION_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')!],
            queue: configService.get<string>(
              'RABBITMQ_QUEUE',
              'notification_queue',
            ),
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class MessagingModule {}
