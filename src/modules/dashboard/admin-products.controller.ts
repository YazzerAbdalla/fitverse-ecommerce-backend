import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { UserRoles } from '../users/enum/roles';
import {
  AdminProductsService,
  AdminProductView,
  AdminProductListMeta,
} from './admin-products.service';
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
  constructor(private readonly adminProductsService: AdminProductsService) {}

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
}
