import { Product } from './entities/product.entity';

// GraphQL update inputs may carry `stock` (owned by Inventory at runtime);
// service strips it before merging so the Product row never persists stock.
export type ManyPartialProducts = (Partial<Product> &
  Pick<Product, 'id'> & { stock?: number })[];
