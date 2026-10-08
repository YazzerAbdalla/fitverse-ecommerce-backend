import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { Inventory } from '../inventory/entities/inventory.entity';
import { AdminProductListQueryDto } from './dto/admin-product-list.query.dto';

/** Derived read-only stock label per product (never stored, never accepted). */
export type StockStatus = 'in-stock' | 'low-stock' | 'out-of-stock';

/** One admin product-list row with derived quantity and status. */
export interface AdminProductView {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  stock: number;
  reservedAmount: number;
  available: number;
  status: StockStatus;
}

/** Pagination envelope reused from the repo listing shape. */
export interface AdminProductListMeta {
  totalItems: number;
  itemCount: number;
  itemsPerPage: number;
  totalPages: number;
  currentPage: number;
}

const DEFAULT_LOW_THRESHOLD = 5;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Single status expression for SQL-side filtering (research D4).
// It mirrors mapStockStatus below branch-for-branch; the TS mapper is
// the response-path definition, this CASE is the filter-path mirror
// (duplication is intentional and pinned by the T007/T008 suites).
const STOCK_STATUS_CASE = `CASE WHEN (COALESCE(inventory."stock", 0) - COALESCE(inventory."reservedAmount", 0)) <= 0 THEN 'out-of-stock' WHEN (COALESCE(inventory."stock", 0) - COALESCE(inventory."reservedAmount", 0)) <= :lowThreshold THEN 'low-stock' ELSE 'in-stock' END`;

/**
 * Derives the stock status from available quantity and threshold.
 *
 * @param available - On-hand stock minus reserved units (>= 0 in practice).
 * @param lowThreshold - Warning threshold (0 makes low-stock unreachable).
 * @returns The derived StockStatus label.
 */
export function mapStockStatus(
  available: number,
  lowThreshold: number,
): StockStatus {
  // Zero (or negative, defensively) means nothing sellable.
  if (available <= 0) {
    return 'out-of-stock';
  }
  // Within threshold (inclusive upper bound) warns; above is healthy.
  if (available <= lowThreshold) {
    return 'low-stock';
  }
  return 'in-stock';
}

/**
 * Escapes LIKE wildcards so search input cannot inject pattern logic.
 *
 * @param value - Raw user search text.
 * @returns Value with \, %, _ escaped for use under ESCAPE '\'.
 */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * This service is responsible for the admin product & stock read model.
 * It aggregates Product + Inventory in one joined, paginated query and
 * derives available quantity and stock status on read. It never writes:
 * creation goes through ProductsService, stock edits through
 * InventoryService.adjustStockByDelta. Reads bypass the filter-blind
 * products:list:* cache entirely.
 */
@Injectable()
export class AdminProductsService {
  private readonly logger = new Logger(AdminProductsService.name);

  // DataSource (not @InjectRepository) for a read-only join: this is the
  // documented dashboard-aggregator exception (plan 20.5), never a write
  // path and never a substitute for the owning services.
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Lists products with derived stock status, search, filters, pagination.
   *
   * @param query - Validated list query (threshold/page/limit defaulted).
   * @returns Paginated envelope of AdminProductView rows.
   * @throws BadRequestException if minPrice exceeds maxPrice (no query runs).
   */
  async listAdminProducts(
    query: AdminProductListQueryDto,
  ): Promise<{ data: AdminProductView[]; meta: AdminProductListMeta }> {
    const lowThreshold = query.lowThreshold ?? DEFAULT_LOW_THRESHOLD;
    const page = query.page ?? DEFAULT_PAGE;
    // Cap client limits so one admin page cannot dump the catalog.
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // Cross-field guard lives in the service: DTO ranges alone cannot
    // express minPrice <= maxPrice, and the check must run before any query.
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException(
        'minPrice must not exceed maxPrice for admin product list',
      );
    }

    const queryBuilder = this.dataSource
      .getRepository(Product)
      .createQueryBuilder('product')
      // LEFT JOIN keeps orphan products listable (Q3/B: out-of-stock zeros).
      .leftJoin(Inventory, 'inventory', 'inventory."productId" = product.id')
      .select('product.id', 'id')
      .addSelect('product.name', 'name')
      .addSelect('product.slug', 'slug')
      .addSelect('product.description', 'description')
      .addSelect('product.price', 'price')
      // COALESCE turns the missing-row join into listable zeros.
      .addSelect('COALESCE(inventory."stock", 0)', 'stock')
      .addSelect('COALESCE(inventory."reservedAmount", 0)', 'reservedAmount')
      .addSelect(
        '(COALESCE(inventory."stock", 0) - COALESCE(inventory."reservedAmount", 0))',
        'available',
      )
      .where('1 = 1')
      .setParameters({ lowThreshold });

    if (query.search) {
      queryBuilder.andWhere(`product.name ILIKE :search ESCAPE '\\'`, {
        search: `%${escapeLikeWildcards(query.search)}%`,
      });
    }
    if (query.status) {
      // Status filtering happens in SQL on the same CASE before
      // pagination, so meta.totalItems counts post-filter rows (B1).
      queryBuilder.andWhere(`${STOCK_STATUS_CASE} = :statusFilter`, {
        statusFilter: query.status,
      });
    }
    if (query.minPrice !== undefined) {
      queryBuilder.andWhere('product.price >= :minPrice', {
        minPrice: query.minPrice,
      });
    }
    if (query.maxPrice !== undefined) {
      queryBuilder.andWhere('product.price <= :maxPrice', {
        maxPrice: query.maxPrice,
      });
    }

    // Clone for the count BEFORE paginating, so totals span all pages.
    const countQueryBuilder = queryBuilder
      .clone()
      .select('COUNT(DISTINCT product.id)', 'count');

    const rows = await queryBuilder
      // Deterministic order keeps pages stable across requests.
      .orderBy('product.name', 'ASC')
      .addOrderBy('product.id', 'ASC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<{
        id: string;
        name: string;
        slug: string;
        description: string;
        price: number | string;
        stock: number | string | null;
        reservedAmount: number | string | null;
        available: number | string | null;
      }>();
    const countRow = await countQueryBuilder.getRawOne<{ count: string }>();
    const totalItems = Number(countRow?.count ?? 0);

    // Raw numerics may arrive as strings; coerce once at the boundary.
    const data: AdminProductView[] = rows.map((row) => {
      const stock = Number(row.stock ?? 0);
      const reservedAmount = Number(row.reservedAmount ?? 0);
      const available = Number(row.available ?? 0);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        price: Number(row.price),
        stock,
        reservedAmount,
        available,
        status: mapStockStatus(available, lowThreshold),
      };
    });

    this.logger.debug(
      `Admin product list: ${data.length}/${totalItems} rows (page ${page})`,
    );

    return {
      data,
      meta: {
        totalItems,
        itemCount: data.length,
        itemsPerPage: limit,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: page,
      },
    };
  }
}
