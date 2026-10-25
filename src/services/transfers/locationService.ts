// locationService.ts — Normalized Location Resolution & Organization Access
import { localDb } from '../../local-db';
import { LocationType } from '../../domain/units';
import { LocationRef } from '../../domain/transferTypes';

export class LocationService {
  /**
   * Resolve normalized location reference by type and id
   */
  static resolveLocation(locationType: LocationType, locationId: string, organizationId: string): LocationRef {
    if (locationType === 'STORE') {
      const store: any = localDb
        .prepare(
          `SELECT id, _local_id, organization_id, store_code as code, name, display_name, address, city, state
           FROM stores
           WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
        )
        .get(locationId, locationId, organizationId);

      if (!store) {
        throw new Error(`Store not found: ${locationId} in organization: ${organizationId}`);
      }

      return {
        type: 'STORE',
        id: store.id,
        organizationId: store.organization_id,
        code: store.code || store.store_code,
        name: store.display_name || store.name,
        address: store.address || null,
        coldStorageSupported: true,
      };
    } else {
      const wh: any = localDb
        .prepare(
          `SELECT id, _local_id, organization_id, warehouse_code as code, name, address, cold_storage_supported
           FROM warehouses
           WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
        )
        .get(locationId, locationId, organizationId);

      if (!wh) {
        throw new Error(`Warehouse not found: ${locationId} in organization: ${organizationId}`);
      }

      return {
        type: 'WAREHOUSE',
        id: wh.id,
        organizationId: wh.organization_id,
        code: wh.code || wh.warehouse_code,
        name: wh.name,
        address: wh.address || null,
        coldStorageSupported: Boolean(wh.cold_storage_supported),
      };
    }
  }

  /**
   * List all valid locations within an organization
   */
  static listLocations(organizationId: string): LocationRef[] {
    const stores: any[] = localDb
      .prepare(
        `SELECT id, _local_id, organization_id, store_code as code, name, display_name, address
         FROM stores
         WHERE (organization_id = ?) AND status = 'active' AND _deleted = 0`
      )
      .all(organizationId);

    const warehouses: any[] = localDb
      .prepare(
        `SELECT id, _local_id, organization_id, warehouse_code as code, name, address, cold_storage_supported
         FROM warehouses
         WHERE (organization_id = ?) AND status = 'active' AND _deleted = 0`
      )
      .all(organizationId);

    const result: LocationRef[] = [];

    for (const s of stores) {
      result.push({
        type: 'STORE',
        id: s.id,
        organizationId: s.organization_id,
        code: s.code || s.store_code,
        name: s.display_name || s.name,
        address: s.address || null,
        coldStorageSupported: true,
      });
    }

    for (const w of warehouses) {
      result.push({
        type: 'WAREHOUSE',
        id: w.id,
        organizationId: w.organization_id,
        code: w.code || w.warehouse_code,
        name: w.name,
        address: w.address || null,
        coldStorageSupported: Boolean(w.cold_storage_supported),
      });
    }

    return result;
  }

  /**
   * Validate if a user is permitted to perform operations at a location
   */
  static validateUserAccess(
    userId: string,
    locationType: LocationType,
    locationId: string,
    organizationId: string
  ): boolean {
    if (!userId || userId === 'SYSTEM' || userId === 'SYSTEM_AUTO') return true;

    // Check super admin or organization-level access
    const uoa: any = localDb
      .prepare(
        `SELECT * FROM user_organization_access
         WHERE user_id = ? AND (organization_id = ?) AND is_active = 1`
      )
      .get(userId, organizationId);

    if (uoa && (uoa.role === 'OWNER' || uoa.role === 'ADMIN' || uoa.role === 'HQ_PROCUREMENT' || uoa.role === 'SUPER_ADMIN')) {
      return true;
    }

    if (locationType === 'STORE') {
      const usa: any = localDb
        .prepare(
          `SELECT * FROM user_store_access
           WHERE user_id = ? AND (store_id = ? OR store_id = ?) AND is_active = 1`
        )
        .get(userId, locationId, locationId);
      return Boolean(usa || uoa);
    } else {
      const wh: any = localDb
        .prepare(
          `SELECT * FROM warehouses
           WHERE (id = ? OR _local_id = ?) AND manager_user_id = ?`
        )
        .get(locationId, locationId, userId);
      return Boolean(wh || uoa);
    }
  }
}
