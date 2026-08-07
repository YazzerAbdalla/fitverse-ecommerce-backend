import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppDataSource } from './data-source';
import { createKeyv } from '@keyv/redis';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
import { CacheTestService } from './cache-test.service';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { OrderModule } from './modules/order/order.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProductsModule } from './modules/products/products.module';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { InventoryModule } from './modules/inventory/inventory.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...AppDataSource.options, autoLoadEntities: true }), // 1. Pass the configuration options
      dataSourceFactory: async () => {
        // 2. Return the existing instance or initialize it if needed
        if (!AppDataSource.isInitialized) {
          await AppDataSource.initialize();
        }
        return AppDataSource;
      },
    }),
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        stores: [createKeyv(configService.get<string>('REDIS_URL'))],
        ttl: 60 * 1000,
      }),
      isGlobal: true,
    }),
    ClientsModule.registerAsync([
      {
        name: 'NOTIFICATION_SERVICE',
        imports: [ConfigModule], // Import ConfigModule here
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')!], // Read from .env
            queue: configService.get<string>(
              'RABBITMQ_QUEUE',
              'notification_queue',
            ),
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService], // Inject ConfigService
      },
    ]),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
    }),
    AuthModule,
    OrderModule,
    UsersModule,
    ProductsModule,
    InventoryModule,
  ],
  controllers: [AppController],
  providers: [AppService, CacheTestService],
})
export class AppModule {}
