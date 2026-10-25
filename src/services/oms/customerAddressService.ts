// customerAddressService.ts — Customer Address Management Service
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { CustomerAddress } from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export class CustomerAddressService {
  /**
   * Get all addresses for a customer within an organization
   */
  static getCustomerAddresses(organizationId: string, customerId: string): CustomerAddress[] {
    const rows: any[] = localDb
      .prepare(
        `SELECT * FROM customer_addresses 
         WHERE organization_id = ? AND customer_id = ? AND _deleted = 0 AND (deleted_at IS NULL)
         ORDER BY is_default DESC, created_at DESC`
      )
      .all(organizationId, customerId);

    return rows.map(r => ({
      ...r,
      is_default: Boolean(r.is_default),
      latitude: r.latitude != null ? Number(r.latitude) : null,
      longitude: r.longitude != null ? Number(r.longitude) : null,
    }));
  }

  /**
   * Get a single address by ID
   */
  static getAddressById(addressId: string, organizationId: string): CustomerAddress | null {
    const row: any = localDb
      .prepare(
        `SELECT * FROM customer_addresses 
         WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0 AND (deleted_at IS NULL)`
      )
      .get(addressId, addressId, organizationId);

    if (!row) return null;

    return {
      ...row,
      is_default: Boolean(row.is_default),
      latitude: row.latitude != null ? Number(row.latitude) : null,
      longitude: row.longitude != null ? Number(row.longitude) : null,
    };
  }

  /**
   * Create or update a customer address
   */
  static saveAddress(params: {
    id?: string;
    organizationId: string;
    customerId: string;
    label?: string;
    recipientName: string;
    phone: string;
    addressLine1: string;
    addressLine2?: string;
    locality?: string;
    city: string;
    state: string;
    stateCode?: string;
    pincode: string;
    landmark?: string;
    latitude?: number;
    longitude?: number;
    isDefault?: boolean;
    deliveryInstructions?: string;
  }): CustomerAddress {
    const {
      id = uuidv4(),
      organizationId,
      customerId,
      label = 'Home',
      recipientName,
      phone,
      addressLine1,
      addressLine2 = '',
      locality = '',
      city,
      state,
      stateCode = '36',
      pincode,
      landmark = '',
      latitude = null,
      longitude = null,
      isDefault = false,
      deliveryInstructions = '',
    } = params;

    if (!recipientName?.trim()) {
      throw new AppError(400, 'Recipient name is required for delivery address', 'INVALID_ADDRESS');
    }
    if (!phone?.trim()) {
      throw new AppError(400, 'Phone number is required for delivery address', 'INVALID_ADDRESS');
    }
    if (!addressLine1?.trim() || !city?.trim() || !state?.trim() || !pincode?.trim()) {
      throw new AppError(400, 'Complete address (line 1, city, state, pincode) is required', 'INVALID_ADDRESS');
    }

    const nowIso = new Date().toISOString();

    // If setting as default, unset existing default
    if (isDefault) {
      localDb
        .prepare(
          `UPDATE customer_addresses 
           SET is_default = 0, updated_at = ?, _updated_at = ?
           WHERE organization_id = ? AND customer_id = ?`
        )
        .run(nowIso, nowIso, organizationId, customerId);
    }

    const existing: any = localDb
      .prepare('SELECT id FROM customer_addresses WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(id, id, organizationId);

    if (existing) {
      localMutate({
        table: 'customer_addresses',
        operation: 'UPDATE',
        data: {
          id: existing.id,
          label,
          recipient_name: recipientName,
          phone,
          address_line_1: addressLine1,
          address_line_2: addressLine2,
          locality,
          city,
          state,
          state_code: stateCode,
          pincode,
          landmark,
          latitude,
          longitude,
          is_default: isDefault ? 1 : 0,
          delivery_instructions: deliveryInstructions,
          updated_at: nowIso,
        },
      });
    } else {
      localMutate({
        table: 'customer_addresses',
        operation: 'INSERT',
        data: {
          id,
          _local_id: id,
          organization_id: organizationId,
          customer_id: customerId,
          label,
          recipient_name: recipientName,
          phone,
          address_line_1: addressLine1,
          address_line_2: addressLine2,
          locality,
          city,
          state,
          state_code: stateCode,
          pincode,
          landmark,
          latitude,
          longitude,
          is_default: isDefault ? 1 : 0,
          delivery_instructions: deliveryInstructions,
          created_at: nowIso,
          updated_at: nowIso,
        },
      });
    }

    return this.getAddressById(id, organizationId)!;
  }
}
