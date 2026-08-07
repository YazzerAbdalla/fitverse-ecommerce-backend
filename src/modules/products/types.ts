import { Product } from './entities/product.entity';

export type ManyPartialProducts = (Partial<Product> & Pick<Product, 'id'>)[];
