// orderPickupService.ts — Click & Collect Pickup Verification Engine
import crypto from 'crypto';
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { AppError } from '../../lib/appError';

export class OrderPickupService {
  /**
   * Generate secure 6-character random pickup code and SHA-256 hash
   */
  static generatePickupCode(): { code: string; hash: string } {
    // 6-digit numeric or alphanumeric pickup code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    return { code, hash };
  }

  /**
   * Verify pickup code presented by customer at counter
   */
  static verifyPickupCode(params: {
    orderId: string;
    organizationId: string;
    storeId?: string | null;
    pickupCode: string;
    verifiedByUserId: string;
  }): { valid: boolean; order: any } {
    const { orderId, organizationId, storeId, pickupCode, verifiedByUserId } = params;

    const order: any = localDb
      .prepare(
        `SELECT * FROM orders 
         WHERE (id = ? OR order_number = ?) AND organization_id = ? AND _deleted = 0`
      )
      .get(orderId, orderId, organizationId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    if (order.status !== 'READY_FOR_PICKUP' && order.status !== 'PACKED') {
      throw new AppError(
        400,
        `Order is not ready for pickup (current status: '${order.status}')`,
        'ORDER_NOT_READY'
      );
    }

    // Verify hash
    const inputHash = crypto.createHash('sha256').update(pickupCode.trim()).digest('hex');
    const isValid =
      order.pickup_code === pickupCode.trim() ||
      order.pickup_code_hash === inputHash ||
      order.pickup_code_hash === pickupCode.trim();

    if (!isValid) {
      throw new AppError(400, 'Invalid pickup PIN or verification code', 'INVALID_PICKUP_CODE');
    }

    const nowIso = new Date().toISOString();

    localMutate({
      table: 'orders',
      operation: 'UPDATE',
      data: {
        id: order.id,
        pickup_verified_at: nowIso,
        pickup_verified_by: verifiedByUserId,
        updated_at: nowIso,
      },
    });

    return { valid: true, order };
  }
}
