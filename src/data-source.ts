/**
 * This module is responsible for the shared TypeORM DataSource configuration.
 * It defines connection settings and the entity closure (metadata) for PostgreSQL.
 *
 * Responsibility (SRP): database connection + entity metadata wiring, nothing else.
 * Used by: app.module.ts (TypeOrmModule.forRootAsync via dataSourceFactory),
 *   run-migrations scripts, and any direct AppDataSource consumer.
 * Depends on: entity classes under src/modules/*, dotenv (.env).
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import User from './modules/users/entity/user.entity';
import { Product } from './modules/products/entities/product.entity';
import { Cart } from './modules/cart/entities/cart.entity';
import { CartItem } from './modules/cart/entities/cart-items.entity';
import { Order } from './modules/order/entities/order.entity';
import { OrderItem } from './modules/order/entities/order-items.entity';
import { Inventory } from './modules/inventory/entities/inventory.entity';
import { Reservation } from './modules/reservation/entities/reservation.entity';
import { ReservationItem } from './modules/reservation/entities/reservation-item.entity';
import { OutboxEvent } from './modules/outbox/entities/outbox-event.entity';
import { RefreshToken } from './modules/auth/entities/refresh-token.entity';
import { PasswordResetToken } from './modules/auth/entities/password-reset-token.entity';
import { EmailVerificationToken } from './modules/auth/entities/email-verification-token.entity';
import { OtpVerification } from './modules/auth/entities/otp-verification.entity';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres', // or 'mysql', 'sqlite', etc.
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT) : 5432,
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE,
  synchronize: false,
  logging: true,
  entities: [
    User,
    Product,
    Cart,
    CartItem,
    Order,
    OrderItem,
    Inventory,
    Reservation,
    ReservationItem,
    OutboxEvent,
    RefreshToken,
    // B3: auth token entities were missing from metadata (tables already exist
    // via migrations; metadata-only change, no schema delta). Notification*
    // entities stay out: their tables do not exist yet (pre-existing gap,
    // notifications scope owns it).
    PasswordResetToken,
    EmailVerificationToken,
    OtpVerification,
  ],
  migrations: ['src/migration/**/*.ts'],
  subscribers: ['src/subscriber/**/*.ts'],
});
