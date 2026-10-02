import { createKeyv } from '@keyv/redis';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheTestService } from './cache-test.service';
import { AppDataSource } from './data-source';
import { AuthModule } from './modules/auth/auth.module';
import { CartModule } from './modules/cart/cart.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { OrderModule } from './modules/order/order.module';
import { ProductsModule } from './modules/products/products.module';
import { ReservationModule } from './modules/reservation/reservation.module';
import { UsersModule } from './modules/users/users.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MessagingModule } from './modules/messaging/messaging.module';

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
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // REDIS_URL takes precedence when provided (ioredis ignores url when host is set)
        const url = configService.get<string>('REDIS_URL');
        if (url) return { connection: { url } };
        return {
          connection: {
            host: configService.get<string>('REDIS_HOST', '127.0.0.1'),
            port: parseInt(configService.get<string>('REDIS_PORT', '6379'), 10),
          },
        };
      },
    }),
    MessagingModule,
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
    CartModule,
    ReservationModule,
    OutboxModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService, CacheTestService],
})
export class AppModule {}
