import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { RateLimitGuard } from '../auth/guards/rate-limit.guard';
import { UserRoles } from '../users/enum/roles';
import { InventoryService } from '../inventory/inventory.service';
import { ProductsService } from '../products/products.service';
import {
  AdminProductsService,
  AdminProductView,
  AdminProductListMeta,
  DEFAULT_LOW_THRESHOLD,
  mapStockStatus,
} from './admin-products.service';
import { AdminCreateProductDto } from './dto/admin-create-product.dto';
import { AdminProductListQueryDto } from './dto/admin-product-list.query.dto';

/**
 * This controller exposes the admin product & stock surface.
 * It is thin by design: it parses input via DTOs, enforces the
 * admin role, and delegates every read/write to services.
 * Demo scope (019): product list (US1); creation (US2) and stock
 * adjust (US3) handlers are added by T015/T019 in this same file.
 */
@ApiTags('admin-products')
@ApiBearerAuth()
@Controller('admin/products')
export class AdminProductsController {
  constructor(
    private readonly adminProductsService: AdminProductsService,
    private readonly productsService: ProductsService,
    private readonly inventoryService: InventoryService,
  ) {}

  /**
   * Lists products with derived stock status for admins.
   * Unthrottled read (recorded THROTTLE exemption, consistent with
   * existing GET policy); writes in this controller carry the
   * 30/h-per-admin quota via RateLimitGuard outermost.
   *
   * @param query - Validated search/filter/pagination parameters.
   * @returns Paginated envelope of admin product views.
   * @throws ForbiddenException for non-admin callers via RolesGuard.
   */
  @Get()
  @Auth(UserRoles.Admin)
  @ApiOperation({ summary: 'List products with stock status (admin)' })
  @ApiResponse({ status: 200, description: 'Paginated admin product views' })
  @ApiResponse({ status: 400, description: 'Invalid pagination/filter values' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Non-admin caller' })
  async listAdminProducts(
    @Query() query: AdminProductListQueryDto,
  ): Promise<{ data: AdminProductView[]; meta: AdminProductListMeta }> {
    return this.adminProductsService.listAdminProducts(query);
  }

  /**
   * Creates a product with optional initial stock for admins.
   * Delegates persistence to ProductsService.create (slug, duplicate
   * 409, inventory row, cache invalidation all reused); this handler
   * only maps the REST body field-by-field and composes the 201 view.
   *
   * @param dto - Validated creation body (stock omitted defaults to zero).
   * @returns Created product view with derived availability and status.
   * @throws ConflictException on duplicate name/slug (nothing created).
   */
  @Post()
  @UseGuards(RateLimitGuard)
  @Auth(UserRoles.Admin)
  @ApiOperation({ summary: 'Create product with initial stock (admin)' })
  @ApiResponse({ status: 201, description: 'Created product view' })
  @ApiResponse({ status: 400, description: 'Validation failure' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Non-admin caller' })
  @ApiResponse({ status: 409, description: 'Duplicate name/slug' })
  @ApiResponse({ status: 429, description: 'Rate limited (30/h per admin)' })
  async createAdminProduct(
    @Body() dto: AdminCreateProductDto,
  ): Promise<AdminProductView> {
    // Explicit field map: never pass the REST DTO straight through —
    // slug is server-derived inside ProductsService.create.
    const created = await this.productsService.create({
      name: dto.name,
      description: dto.description,
      price: dto.price,
      stock: dto.stock ?? 0,
    });
    const inventory = await this.inventoryService.getInventory(created.id);
    const stock = Number(inventory.stock);
    const reservedAmount = Number(inventory.reservedAmount);
    const available = Number(inventory.available);
    return {
      id: created.id,
      name: created.name,
      slug: created.slug,
      description: created.description,
      price: Number(created.price),
      stock,
      reservedAmount,
      available,
      status: mapStockStatus(available, DEFAULT_LOW_THRESHOLD),
    };
  }
}
