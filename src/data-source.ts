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
  ],
  migrations: ['src/migration/**/*.ts'],
  subscribers: ['src/subscriber/**/*.ts'],
});
