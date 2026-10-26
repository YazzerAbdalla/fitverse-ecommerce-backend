import { ROLESKEY } from '../auth/decorators/auth.decorator';
import { UserRoles } from '../users/enum/roles';
import { InventoryController } from './inventory.controller';

/**
 * Pins the 019 T002b boundary: stock-mutating legacy routes are
 * admin-only while reads stay any-role. Wire-level 403/200 proof
 * lives in test/admin-products.e2e-spec.ts (T022).
 */
describe('InventoryController (019 T002b role boundary)', () => {
  const rolesOf = (method: keyof InventoryController): UserRoles[] =>
    Reflect.getMetadata(ROLESKEY, InventoryController.prototype[method]) ?? [];

  it('restricts POST :productId/increase to Admin', () => {
    expect(rolesOf('increaseStock')).toEqual([UserRoles.Admin]);
  });

  it('restricts POST :productId/decrease to Admin', () => {
    expect(rolesOf('decreaseStock')).toEqual([UserRoles.Admin]);
  });

  it('keeps inventory reads any-role', () => {
    expect(rolesOf('getInventory')).toEqual([]);
    expect(rolesOf('checkProductAvailability')).toEqual([]);
  });
});
